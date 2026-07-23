import * as affine from "@s3-cog/affine";
import { epsgResolver, parseWkt } from "@s3-cog/proj";
import proj4 from "proj4";

// API base URL: window.S3_COG_API_BASE (config.js, set at S3 deploy time) or
// a ?api= override, else "" = same origin (Lambda-served viewer). All API
// calls go through apiFetch so the static S3 viewer can reach the API on
// another origin. (CORS on the Function URL already allows "*".)
const API_BASE = (
  window.S3_COG_API_BASE ||
  new URLSearchParams(location.search).get("api") ||
  ""
).replace(/\/$/, "");
const apiFetch = (path, opts) => fetch(`${API_BASE}${path}`, opts);
const S1M_API_BASE = (window.S3_COG_S1M_API_BASE || API_BASE).replace(
  /\/$/,
  "",
);
const S1M_DEMO_TOKEN = window.S3_COG_S1M_DEMO_TOKEN || "";
// The ingest token gates the write endpoints, and is deliberately NOT shipped
// with the viewer. A static bundle on a public bucket is a public client: it
// cannot hold a secret, so baking the token in published it to everyone who
// could load the page. It is pasted per browser session and kept in
// sessionStorage, so it never enters the deployed assets and dies with the tab.
// window.S3_COG_INGEST_TOKEN is still honoured for local dev, where config.js is
// generated on the developer's own machine and never published.
const INGEST_TOKEN_STORAGE_KEY = "s3cog.ingestToken";

function storedIngestToken() {
  try {
    return sessionStorage.getItem(INGEST_TOKEN_STORAGE_KEY) || "";
  } catch {
    return ""; // storage blocked (private mode, strict cookie policy)
  }
}

// Holds the typed value when sessionStorage is unavailable, so a blocked-storage
// browser still works for the current page load.
let ingestTokenMemory = "";

function ingestToken() {
  return (
    ingestTokenMemory || storedIngestToken() || window.S3_COG_INGEST_TOKEN || ""
  );
}

// STAC projection extension v2.0 replaced the numeric `proj:epsg` with the
// string `proj:code` ("EPSG:26918"), and its schema rejects Items that
// still carry proj:epsg -- so /search emits proj:code only. Pull the
// numeric EPSG back out of it, tolerating the old field on any response
// from a stale API deployment.
function parseEpsgCode(props) {
  const code = props?.["proj:code"];
  if (typeof code === "string") {
    const match = /^EPSG:(\d+)$/i.exec(code.trim());
    if (match) {
      return Number(match[1]);
    }
  }
  const legacy = props?.["proj:epsg"];
  return Number.isFinite(legacy) ? Number(legacy) : undefined;
}

// --- LIVE DEBUG CONSOLE RECORDER ---
// Off by default: the on-page panel (#debug-overlay) is hidden and the
// console overrides below are disabled so logging does no DOM work.
// Flip DEBUG_CONSOLE_ENABLED to true (and unhide #debug-overlay) to use it.
const DEBUG_CONSOLE_ENABLED = false;
const debugLogsEl = document.getElementById("debug-logs");
const clearDebugBtn = document.getElementById("clear-debug-btn");

clearDebugBtn.addEventListener("click", () => {
  if (debugLogsEl) {
    debugLogsEl.innerHTML = "";
  }
});

const DEBUG_LOG_MAX_LINES = 500;
let _debugScrollQueued = false;
function addDebugLog(msg, isErr = false) {
  if (!DEBUG_CONSOLE_ENABLED || !debugLogsEl) {
    return;
  }
  const line = document.createElement("div");
  line.className = `debug-log-line${isErr ? " debug-log-err" : ""}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${msg}`;
  debugLogsEl.appendChild(line);
  // Cap the panel so the DOM does not grow unbounded over a session.
  while (debugLogsEl.childElementCount > DEBUG_LOG_MAX_LINES) {
    debugLogsEl.removeChild(debugLogsEl.firstElementChild);
  }
  // Batch the scroll into one rAF so bursts of logs trigger a single
  // layout/reflow instead of one per line.
  if (!_debugScrollQueued) {
    _debugScrollQueued = true;
    requestAnimationFrame(() => {
      _debugScrollQueued = false;
      debugLogsEl.scrollTop = debugLogsEl.scrollHeight;
    });
  }
}

function formatDebugArg(a) {
  if (a instanceof Error) {
    // JSON.stringify(new Error("boom")) is "{}" -- the panel exists to capture
    // errors, so stringifying them to nothing defeats the point.
    return a.stack || `${a.name}: ${a.message}`;
  }
  if (typeof a !== "object" || a === null) {
    return String(a);
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a); // circular, or a throwing toJSON
  }
}

// Only patch the global console when the panel is actually on. Installing these
// unconditionally overrode console.log/error for the whole page forever, and --
// because a function's arguments are evaluated before the call -- ran the full
// map/stringify on every log site just for addDebugLog to drop the result.
if (DEBUG_CONSOLE_ENABLED) {
  const _origLog = console.log;
  const _origErr = console.error;
  console.log = (...args) => {
    _origLog(...args);
    addDebugLog(args.map(formatDebugArg).join(" "));
  };
  console.error = (...args) => {
    _origErr(...args);
    addDebugLog(args.map(formatDebugArg).join(" "), true);
  };
  addDebugLog("Live debug console initialised.");
}

let layerNumberControlEl = null;

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [-74.5, 40.15],
  zoom: 10,
  zoomSnap: 1,
});
// Debug handle (this is a debug viewer): lets devtools/scripted checks
// drive the closure-scoped map (jumpTo, fire) without UI gymnastics.
window.__map = map;

const stateEl = document.getElementById("state");
const yearEl = document.getElementById("year");
const activeCollectionSummaryEl = document.getElementById(
  "active-collection-summary",
);
let activeSearchCollectionId = "naip";
let searchableCollectionIds = new Set(["naip"]);
const activeCollection = () => activeSearchCollectionId || "naip";
// The COG-imagery toggle renders the ACTIVE collection's tiles, so its label
// tracks the selection (only one collection is "hot" at a time).
function updateCogLayerLabel() {
  const id = activeCollection();
  const title = collectionById[id]?.title || id.toUpperCase();

  const el = document.getElementById("cog-layer-label");
  if (el) {
    el.textContent = `${title} Imagery (COG Tiles)`;
  }
}
function renderActiveCollectionSummary() {
  if (!activeCollectionSummaryEl) {
    return;
  }
  const id = activeCollection();
  const p = collectionById[id];
  const title = p?.title || id.toUpperCase();
  activeCollectionSummaryEl.innerHTML = `Search collection: <strong>${title}</strong> <span class="muted">(${id})</span>`;
}
const limitEl = document.getElementById("limit");
// Default search `limit` (max footprints per /search). One source maps to
// one MosaicLayer cache slot, so this is also the typical working-set size
// that drives `maxCacheSize` below. The server hard-caps `limit` at 18000.
const SEARCH_LIMIT_DEFAULT = 18000;
limitEl.value = String(SEARCH_LIMIT_DEFAULT);
const footprintLayerModeEls = Array.from(
  document.querySelectorAll('input[name="footprint-layer-mode"]'),
);
const toggleCogEl = document.getElementById("toggle-cog-layer");
const toggleUsgsNaipWmsLayerEl = document.getElementById(
  "toggle-usgs-naip-wms-layer",
);
const toggleNaipSearchFootprintsLayerEl = document.getElementById(
  "toggle-naip-search-footprints-layer",
);
const toggleS1MFootprintsLayerEl = document.getElementById(
  "toggle-s1m-footprints-layer",
);
const toggleNaipCoverageMvtLayerEl = document.getElementById(
  "toggle-naip-coverage-mvt-layer",
);

const terBuildingsEl = document.getElementById("ter-buildings");
const terBuildingsStatusEl = document.getElementById("ter-buildings-status");
const brightnessEl = document.getElementById("brightness");
const brightnessValueEl = document.getElementById("brightness-value");
const contrastEl = document.getElementById("contrast");
const contrastValueEl = document.getElementById("contrast-value");
const resetDisplayEl = document.getElementById("reset-display");

// Default view: open with the 2D search-results footprints and the NAIP
// imagery (COG tiles) already on, so the map lands on the flat imagery +
// returned-COG outlines from the initial auto-search. USGS WMS and the
// coverage MVT / S1M coverage footprints stay OFF; each can be toggled from
// its control. The terrain mesh+drape is driven by s1mActive, independent
// of these toggles.
const footprintLayerSearchEl = document.getElementById(
  "footprint-layer-search",
);
if (footprintLayerSearchEl) {
  footprintLayerSearchEl.checked = true; // 2D search-results footprints on
}
toggleNaipSearchFootprintsLayerEl.checked = true; // hidden checkbox the radio drives
toggleCogEl.checked = true; // background NAIP raster (COG tiles) on
toggleUsgsNaipWmsLayerEl.checked = false;
toggleS1MFootprintsLayerEl.checked = false; // coverage-footprint vector off
toggleNaipCoverageMvtLayerEl.checked = false; // NAIP coverage MVT vector off

const summaryEl = document.getElementById("summary");
const timingSummaryEl = document.getElementById("timing-summary");
const imageryStatusEl = document.getElementById("imagery-status");
const resolutionDebugEl = document.getElementById("resolution-debug");

const resultsEl = document.getElementById("results");
// Only the top-level tabs carry data-tab. The ingest-mode buttons reuse the
// .tab-button style but manage their own state (switchIngestMode); scoping to
// [data-tab] keeps switchTab off them, or clicking a mode button would fire
// switchTab(undefined) and blank every .tab-panel.
const tabButtons = Array.from(
  document.querySelectorAll(".tab-button[data-tab]"),
);
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
const refreshEnvironmentBtn = document.getElementById("refresh-environment");
const environmentChecksEl = document.getElementById("environment-checks");
const environmentConfigEl = document.getElementById("environment-config");
// Dual-mode Ingest controls
const ingestModeCatalogBtn = document.getElementById("ingest-mode-catalog");
const ingestModeCustomBtn = document.getElementById("ingest-mode-custom");
const ingestCatalogFieldsWrap = document.getElementById(
  "ingest-catalog-fields",
);
const ingestCustomFieldsWrap = document.getElementById("ingest-custom-fields");

const ingestCatalogCollectionEl = document.getElementById(
  "ingest-catalog-collection",
);
const ingestCatalogRegionEl = document.getElementById("ingest-catalog-region");
const ingestCatalogYearEl = document.getElementById("ingest-catalog-year");
const ingestCatalogStrategyEl = document.getElementById(
  "ingest-catalog-strategy",
);

const ingestCustomBucketEl = document.getElementById("ingest-custom-bucket");
const ingestCustomPrefixEl = document.getElementById("ingest-custom-prefix");
const ingestCustomCollectionEl = document.getElementById(
  "ingest-custom-collection",
);
const ingestCustomRegionEl = document.getElementById("ingest-custom-region");
const ingestCustomYearEl = document.getElementById("ingest-custom-year");
const ingestCustomAccessEl = document.getElementById("ingest-custom-access");
const ingestCustomStrategyEl = document.getElementById(
  "ingest-custom-strategy",
);

const ingestLimitEl = document.getElementById("ingest-limit");
const ingestWorkersEl = document.getElementById("ingest-workers");
const ingestAccessKeyEl = document.getElementById("ingest-access-key");
const ingestSecretKeyEl = document.getElementById("ingest-secret-key");

// Load persisted credentials
ingestAccessKeyEl.value = localStorage.getItem("ingest-access-key") || "";
ingestSecretKeyEl.value = localStorage.getItem("ingest-secret-key") || "";

ingestAccessKeyEl.addEventListener("input", () => {
  localStorage.setItem("ingest-access-key", ingestAccessKeyEl.value.trim());
});
ingestSecretKeyEl.addEventListener("input", () => {
  localStorage.setItem("ingest-secret-key", ingestSecretKeyEl.value.trim());
});

// Server-side sync ingest hard cap (S3_COG_SYNC_INGEST_MAX_LIMIT). Sending a
// larger value is rejected; clamp here so the panel can't ask for more.
const INGEST_SYNC_MAX_LIMIT = 500; // empty-field default
const INGEST_LIMIT_MAX = 20000; // panel hard ceiling (0 still = unlimited)
const runIngestBtn = document.getElementById("run-ingest");
const ingestSummaryEl = document.getElementById("ingest-summary");
const ingestLogsEl = document.getElementById("ingest-logs");
const ingestTokenEl = document.getElementById("ingest-token");
const ingestTokenFieldEl = document.getElementById("ingest-token-field");
let deckOverlay = null;
let MVTLayerClass = null;
let MosaicLayerClass = null;
let COGLayerClass = null;
let CutlineBboxModule = null;
let lngLatToWorldFn = null;
let addAlphaChannelFn = null;
let CreateTextureModule = null;
let imageryRevision = 0;
let activeSearchToken = 0;
let pendingSearch = false;
let searchInFlight = false;
let currentFootprintSignature = null;
let currentImagerySignature = null;
let currentImageryHrefs = [];

let mapReady = false;
let autoSearchTimeoutId = null;
const geotiffSourceCache = new Map();
const geotiffSourceResolved = new Map();
const GEOTIFF_SOURCE_CACHE_MAX = 12;
let drapeProjectionCache = new WeakMap();
// Lazy per-tile presign: /search returns raw s3:// hrefs and we sign each
// COG only when deck.gl actually loads it (via GET /sign). signedUrlCache
// keys the signed URL by its s3:// href with an expiry; inflightSigns
// coalesces concurrent requests for the same href into one fetch.
const signedUrlCache = new Map(); // s3href -> { url, expiresAt }
const inflightSigns = new Map(); // s3href -> Promise<string>
// Per-search counters so the timing panel can report client-side signing.
let signCallCount = 0;
let signTotalMs = 0;
// Hrefs we've already re-signed once after a 403/expired error, so a
// persistently failing tile doesn't loop. Reset on each new search.
let resignAttempted = new Set();

function deleteGeotiffSourceCacheEntry(s3href) {
  geotiffSourceCache.delete(s3href);
  geotiffSourceResolved.delete(s3href);
}

function clearGeotiffSourceCache() {
  geotiffSourceCache.clear();
  geotiffSourceResolved.clear();
}

function isExpiredSignatureError(error) {
  for (let e = error; e; e = e.cause) {
    const msg = String(e?.message || "");
    if (
      msg.includes("403") ||
      /expired/i.test(msg) ||
      /accessdenied/i.test(msg)
    ) {
      return true;
    }
  }
  return false;
}

function isAllocationError(error) {
  for (let e = error; e; e = e.cause) {
    const msg = String(e?.message || e || "");
    if (/array buffer allocation failed|out of memory|allocation/i.test(msg)) {
      return true;
    }
  }
  return false;
}

// Registry props for the collection that owns this s3:// href (matched by
// bucket), so imagery access follows the source: public buckets are read
// directly (no presign), requester-pays (NAIP) is presigned via /sign.
function collectionForHref(s3href) {
  if (!s3href) {
    return null;
  }
  let bucket = null;
  if (s3href.startsWith("s3://")) {
    const m = /^s3:\/\/([^/]+)\//.exec(s3href);
    bucket = m ? m[1] : null;
  } else {
    const m = /^https:\/\/([^.]+)\.s3/.exec(s3href);
    bucket = m ? m[1] : null;
  }
  if (!bucket) {
    return null;
  }
  return collectionFeatures.find((p) => p.bucket === bucket) || null;
}
function publicHttpsUrl(s3href, region) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3href);
  if (!m) {
    return s3href;
  }
  // Region-specific virtual-hosted URL when known, else the global
  // endpoint (S3 redirects it to the bucket's region on first request).
  const host = region
    ? `${m[1]}.s3.${region}.amazonaws.com`
    : `${m[1]}.s3.amazonaws.com`;
  return `https://${host}/${m[2]}`;
}
function chunkCacheForHref(s3href) {
  if (!s3href?.startsWith("s3://naip-analytic/")) {
    return undefined;
  }
  return {
    cacheKey: s3href,
    chunkSize: 1024 * 1024,
    cacheName: "naip-analytic-cog-chunks-v1",
    memoryMaxBytes: 8 * 1024 * 1024,
  };
}

async function signHref(s3href) {
  if (!s3href?.startsWith("s3://")) {
    return s3href;
  }
  // Public collection: the browser can range-read the object directly; no
  // presign (and no requester-pays header, which a public bucket rejects).
  const owner = collectionForHref(s3href);
  if (owner && owner.access === "public") {
    // Public bucket: range-read the COG directly from S3 -- no CloudFront
    // proxy, no presign. Requires the source bucket to serve CORS for
    // browser range-reads (e.g. njogis-imagery once its CORS is set).
    return publicHttpsUrl(s3href, owner.bucket_region || owner.region);
  }
  const now = Date.now();
  const cached = signedUrlCache.get(s3href);
  if (cached && cached.expiresAt > now) {
    return cached.url;
  }
  let pending = inflightSigns.get(s3href);
  if (!pending) {
    const startedAt = performance.now();
    // No abort signal here on purpose: signing is cheap and shared across
    // callers, so one caller's pan-abort shouldn't cancel a sign others need.
    pending = apiFetch(`/sign?href=${encodeURIComponent(s3href)}`)
      .then(async (resp) => {
        if (!resp.ok) {
          let detail = "";
          try {
            const body = await resp.json();
            detail = body?.detail ? `: ${body.detail}` : "";
          } catch (_) {
            try {
              const text = await resp.text();
              detail = text ? `: ${text.slice(0, 180)}` : "";
            } catch (_) {}
          }
          throw new Error(`sign failed: ${resp.status}${detail}`);
        }
        const data = await resp.json();
        signCallCount += 1;
        signTotalMs += performance.now() - startedAt;
        // Expire the client cache a minute before the server's window so we
        // re-sign before a tile's URL actually lapses.
        const ttlMs = Math.max(
          0,
          (Number(data.expires_in) || 0) * 1000 - 60000,
        );
        signedUrlCache.set(s3href, {
          url: data.signed,
          expiresAt: ttlMs ? now + ttlMs : now + 60000,
        });
        return data.signed;
      })
      .finally(() => inflightSigns.delete(s3href));
    inflightSigns.set(s3href, pending);
  }
  return pending;
}
let activeIngestJobId = null;
let ingestStatusPollId = null;
// "async" (thread+subprocess + polling) or "sync" (in-process,
// single response) -- reported by /environment. Lazily fetched + cached.
let ingestModeCache = null;
let lastSearchFeatures = [];
let lastSearchBbox = null;
let s1mDrapeSourceKey = null;
let s1mDrapeSources = [];
let s1mDrapeSourcePending = null;
let s1mDrapeSourceError = null;
const s1mDrapeSourceCache = new Map(); // S1M/subtile bbox search key -> {sources, pending, error}
const s1mDrapeMetrics = {
  mode: "analytic RGBIR",
  sourceSearchMs: null,
  sourceRawCount: 0,
  sourceCount: 0,
  sourceError: null,
  tilesStarted: 0,
  tilesCompleted: 0,
  tilesFailed: 0,
  tileSourceRefs: 0,
  analyticRefs: 0,
  totalTileMs: 0,
  lastTileMs: null,
  lastSourceRefs: 0,
  maxSourceRefs: 0,
  noDataSourceFallbacks: 0,
  lastHref: null,
};
const s1mFillMetrics = {
  refreshSeq: 0,
  refreshStartedAt: null,
  desired: 0,
  missingQueued: 0,
  terrainStarted: 0,
  terrainCompleted: 0,
  terrainFailed: 0,
  terrainStale: 0,
  paints: 0,
  lastPaintAt: null,
  lastPaint: null,
};
// Phase-level benchmark accumulator for the S1M terrain + imagery drape
// pipeline. Cheap (performance.now deltas) and always on. Read/reset from
// the console via window.__s1mBenchReport() / window.__s1mBenchReset().
const s1mBench = {
  cogHit: 0,
  cogMiss: 0, // decoded-COG-tile cache effectiveness
  drapeEvict: 0,
  cogEvict: 0,
  tiffEvict: 0, // bounded-cache pressure
  cogFetchMs: 0,
  cogFetchN: 0, // level.fetchTile (network/range reads)
  decodeMs: 0,
  decodeN: 0, // displayDrapeRgbaBytes (band -> rgba)
  rasterMs: 0,
  rasterN: 0, // per-output-pixel reproject+sample loop
  drapeBuildMs: 0,
  drapeBuildN: 0, // summed per-subtile drape durations
  terrainFetchMs: 0,
  terrainFetchN: 0, // /s1m/terrain fetch + json
  meshMs: 0,
  meshN: 0, // elevation decode + CPU mesh build
  tiffSignMs: 0,
  tiffSignN: 0, // TIFF S3 URL presigning
  tiffResolveMs: 0,
  tiffResolveN: 0, // TIFF header reading (fromUrl)
};
function s1mBenchReset() {
  for (const k in s1mBench) {
    s1mBench[k] = 0;
  }
}
function s1mBenchReport() {
  const avg = (ms, n) => (n ? +(ms / n).toFixed(1) : 0);
  const cogTotal = s1mBench.cogHit + s1mBench.cogMiss;
  return {
    cogTileCache: {
      hits: s1mBench.cogHit,
      misses: s1mBench.cogMiss,
      hitRatePct: cogTotal
        ? +((100 * s1mBench.cogHit) / cogTotal).toFixed(0)
        : 0,
    },
    cogFetch: {
      tiles: s1mBench.cogFetchN,
      totalMs: +s1mBench.cogFetchMs.toFixed(0),
      avgMs: avg(s1mBench.cogFetchMs, s1mBench.cogFetchN),
    },
    decode: {
      tiles: s1mBench.decodeN,
      totalMs: +s1mBench.decodeMs.toFixed(0),
      avgMs: avg(s1mBench.decodeMs, s1mBench.decodeN),
    },
    rasterize: {
      passes: s1mBench.rasterN,
      totalMs: +s1mBench.rasterMs.toFixed(0),
      avgMs: avg(s1mBench.rasterMs, s1mBench.rasterN),
    },
    drapeBuild: {
      subtiles: s1mBench.drapeBuildN,
      totalSubtileMs: +s1mBench.drapeBuildMs.toFixed(0),
      avgSubtileMs: avg(s1mBench.drapeBuildMs, s1mBench.drapeBuildN),
    },
    terrainFetch: {
      tiles: s1mBench.terrainFetchN,
      totalMs: +s1mBench.terrainFetchMs.toFixed(0),
      avgMs: avg(s1mBench.terrainFetchMs, s1mBench.terrainFetchN),
    },
    mesh: {
      tiles: s1mBench.meshN,
      totalMs: +s1mBench.meshMs.toFixed(0),
      avgMs: avg(s1mBench.meshMs, s1mBench.meshN),
    },
    tiffSign: {
      calls: s1mBench.tiffSignN,
      totalMs: +s1mBench.tiffSignMs.toFixed(0),
      avgMs: avg(s1mBench.tiffSignMs, s1mBench.tiffSignN),
    },
    tiffResolve: {
      sources: s1mBench.tiffResolveN,
      totalMs: +s1mBench.tiffResolveMs.toFixed(0),
      avgMs: avg(s1mBench.tiffResolveMs, s1mBench.tiffResolveN),
    },
    sourceSearchMs: s1mDrapeMetrics.sourceSearchMs,
    cacheSizes: {
      drapeImages: s1mDrapeCache.size,
      drapeImageMax: S1M_DRAPE_CACHE_MAX,
      decodedCogTiles: s1mCogTileCache.size,
      decodedCogTileMax: S1M_COG_TILE_CACHE_MAX_COUNT,
      geotiffSources: geotiffSourceCache.size,
      geotiffSourceMax: GEOTIFF_SOURCE_CACHE_MAX,
      drapeSourceQueries: s1mDrapeSourceCache.size,
      drapeSourceQueryMax: S1M_DRAPE_SOURCE_CACHE_MAX,
    },
    cacheEvictions: {
      drapeImages: s1mBench.drapeEvict,
      decodedCogTiles: s1mBench.cogEvict,
      geotiffSources: s1mBench.tiffEvict,
    },
    fill: s1mFillReport(),
  };
}
let s1mStatsWindow = null;
let s1mStatsWindowTimer = null;
function s1mOpenStatsWindow() {
  if (s1mStatsWindow && !s1mStatsWindow.closed) {
    s1mStatsWindow.focus();
  } else {
    s1mStatsWindow = window.open("", "s1m-stats", "width=760,height=900");
  }
  if (!s1mStatsWindow) {
    console.warn("S1M stats window was blocked by the browser.");
    return null;
  }
  s1mStatsWindow.document.open();
  s1mStatsWindow.document.write(`<!doctype html>
    <html>
      <head>
        <title>S1M Stats</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background: #0d1117; color: #c9d1d9; }
          header { position: sticky; top: 0; background: #161b22; border-bottom: 1px solid #30363d; padding: 10px 12px; display: flex; align-items: center; }
          button { font-family: inherit; font-size: 12px; font-weight: 500; color: #c9d1d9; background-color: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; cursor: pointer; margin-right: 8px; }
          button:hover { background-color: #30363d; border-color: #8b949e; }
          main { padding: 16px; }
          .section-title { font-size: 14px; font-weight: 600; color: #58a6ff; margin: 20px 0 10px 0; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
          .section-title:first-child { margin-top: 0; }
          .stat-line { display: flex; font-size: 12px; line-height: 1.6; border-bottom: 1px solid #21262d; padding: 6px 0; }
          .stat-line:last-child { border-bottom: none; }
          .stat-label { font-weight: 500; min-width: 220px; color: #c9d1d9; }
          .stat-value { font-weight: 600; color: #f0883e; min-width: 140px; }
          .stat-desc { color: #8b949e; font-size: 11px; }
          pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 0; background: #161b22; padding: 12px; border-radius: 6px; border: 1px solid #30363d; }
          details { margin-top: 24px; border: 1px solid #30363d; border-radius: 6px; background: #161b22; }
          details summary { padding: 10px 12px; font-size: 13px; font-weight: 600; cursor: pointer; color: #58a6ff; outline: none; }
          details summary:hover { color: #79c0ff; }
          details[open] { background: #0d1117; }
          details[open] summary { border-bottom: 1px solid #30363d; }
          .muted { color: #8b949e; font-size: 12px; margin-left: auto; }
        </style>
      </head>
      <body>
        <header>
          <button id="copy">Copy JSON</button>
          <button id="reset">Reset Bench</button>
          <span class="muted" id="stamp"></span>
        </header>
        <main>
          <div id="stats-display">Loading human-readable stats...</div>
          <details>
            <summary>Raw JSON Payload</summary>
            <pre id="stats">Waiting for stats...</pre>
          </details>
        </main>
      </body>
    </html>`);
  s1mStatsWindow.document.close();
  const render = () => {
    if (!s1mStatsWindow || s1mStatsWindow.closed) {
      return;
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      bench: s1mBenchReport(),
      fill: s1mFillReport(),
      memory: cacheMemoryReport(),
    };
    const text = JSON.stringify(payload, null, 2);

    // Generate human-readable HTML list
    let drapeListsHtml = "";
    if (payload.fill.drapePending.length > 0) {
      drapeListsHtml += `
        <div style="margin-top: 8px; padding-left: 15px; font-size: 11px; color: #8b949e;">
          <strong>Pending Sub-tiles:</strong>
          <ul style="margin: 4px 0; padding-left: 20px;">
            ${payload.fill.drapePending.map((k) => `<li>${k}</li>`).join("")}
          </ul>
        </div>
      `;
    }
    if (payload.fill.drapeRefreshing.length > 0) {
      drapeListsHtml += `
        <div style="margin-top: 8px; padding-left: 15px; font-size: 11px; color: #8b949e;">
          <strong>Refreshing Sub-tiles:</strong>
          <ul style="margin: 4px 0; padding-left: 20px;">
            ${payload.fill.drapeRefreshing.map((k) => `<li>${k}</li>`).join("")}
          </ul>
        </div>
      `;
    }
    if (payload.fill.drapeFailed.length > 0) {
      drapeListsHtml += `
        <div style="margin-top: 8px; padding-left: 15px; font-size: 11px; color: #f87171;">
          <strong>Failed Sub-tiles:</strong>
          <ul style="margin: 4px 0; padding-left: 20px;">
            ${payload.fill.drapeFailed.map((item) => `<li>${item.key}: ${item.error}</li>`).join("")}
          </ul>
        </div>
      `;
    }

    const activeCol = activeCollection();
    const memory = payload.memory;
    const displayHtml = `
      <div class="section-title">General / Viewport Status</div>
      <div class="stat-line">
        <span class="stat-label">Active State</span>
        <span class="stat-value">${payload.fill.active ? "Enabled" : "Disabled"}</span>
        <span class="stat-desc">— Is the S1M 3D terrain rendering pipeline active</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Viewport Terrain Tiles</span>
        <span class="stat-value">${payload.fill.desired} tiles</span>
        <span class="stat-desc">— Number of terrain tiles within the current camera viewport</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Refresh Age</span>
        <span class="stat-value">${payload.fill.refreshAgeMs !== null ? `${payload.fill.refreshAgeMs} ms` : "N/A"}</span>
        <span class="stat-desc">— Elapsed time since the last viewport refresh started</span>
      </div>

      <div class="section-title">S1M Terrain Tiles Status (DEM)</div>
      <div class="stat-line">
        <span class="stat-label">Exact LOD Cached</span>
        <span class="stat-value">${payload.fill.terrain.exactCached}</span>
        <span class="stat-desc">— Tiles loaded at the requested Level of Detail (LOD)</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Fallback LOD (Stale)</span>
        <span class="stat-value">${payload.fill.terrain.fallbackCached}</span>
        <span class="stat-desc">— Tiles using a coarser/finer LOD as a temporary fallback</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Missing / Loading</span>
        <span class="stat-value">${payload.fill.terrain.missing}</span>
        <span class="stat-desc">— Tiles currently requesting or waiting for DEM elevation</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">DEM Pending Requests</span>
        <span class="stat-value">${payload.fill.terrain.pending}</span>
        <span class="stat-desc">— Network requests currently in-flight for DEM elevation tiles</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">DEM Total Completed</span>
        <span class="stat-value">${payload.fill.terrain.completed}</span>
        <span class="stat-desc">— Successful DEM tile fetches in this session</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">DEM Total Failed</span>
        <span class="stat-value">${payload.fill.terrain.failed}</span>
        <span class="stat-desc">— Elevation tile network download failures</span>
      </div>

      <div class="section-title">Terrain Draping (Imagery) Status</div>
      <div class="stat-line">
        <span class="stat-label">Drape Collection</span>
        <span class="stat-value">${activeCol}</span>
        <span class="stat-desc">— Currently selected imagery collection for draping</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Total Drape Sub-tiles</span>
        <span class="stat-value">${payload.fill.drape.subtiles}</span>
        <span class="stat-desc">— Number of subdiv sub-tiles constructed for visible tiles</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Textured Sub-tiles</span>
        <span class="stat-value">${payload.fill.drape.textured} (${payload.fill.drape.subtiles ? Math.round((100 * payload.fill.drape.textured) / payload.fill.drape.subtiles) : 0}%)</span>
        <span class="stat-desc">— Sub-tiles that finished loading and painting imagery textures</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Pending Textures</span>
        <span class="stat-value">${payload.fill.drape.pending}</span>
        <span class="stat-desc">— Sub-tiles waiting for imagery textures to build</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Refreshing Textures</span>
        <span class="stat-value">${payload.fill.drape.refreshing}</span>
        <span class="stat-desc">— Sub-tiles with low-res textures, rebuilding higher-res ones</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Failed Textures</span>
        <span class="stat-value" style="color: ${payload.fill.drape.failed > 0 ? "#f87171" : "inherit"};">${payload.fill.drape.failed}</span>
        <span class="stat-desc">— Sub-tiles that failed to acquire or paint textures</span>
      </div>
      ${drapeListsHtml}
      <div class="stat-line">
        <span class="stat-label">COG Source Search Latency</span>
        <span class="stat-value">${Number.isFinite(payload.bench.sourceSearchMs) ? `${payload.bench.sourceSearchMs.toFixed(1)} ms` : "N/A"}</span>
        <span class="stat-desc">— Time spent querying database /search API for overlapping COGs</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">COG Search Queries</span>
        <span class="stat-value">${payload.fill.drape.sourceQueriesReady}/${payload.fill.drape.sourceQueries} ready (${payload.fill.drape.sourceQueriesPending} pending, ${payload.fill.drape.sourceQueriesFailed} failed)</span>
        <span class="stat-desc">— Number of cached tile search bounding box queries</span>
      </div>

      <div class="section-title">Pipeline Performance Benchmarks (Averages)</div>
      <div class="stat-line">
        <span class="stat-label">COG Header Fetch</span>
        <span class="stat-value">${payload.bench.cogFetch.avgMs} ms</span>
        <span class="stat-desc">— Network request to fetch COG TIFF headers/IFDs (Tiles: ${payload.bench.cogFetch.tiles})</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">TIFF Decode to RGBA</span>
        <span class="stat-value">${payload.bench.decode.avgMs} ms</span>
        <span class="stat-desc">— Decoding compressed TIFF bands into raw RGBA bytes (Tiles: ${payload.bench.decode.tiles})</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Reproject & Rasterize</span>
        <span class="stat-value">${payload.bench.rasterize.avgMs} ms</span>
        <span class="stat-desc">— Projecting coordinates and sampling pixels into texture pass (Passes: ${payload.bench.rasterize.passes})</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Drape Subtile Build</span>
        <span class="stat-value">${payload.bench.drapeBuild.avgSubtileMs} ms</span>
        <span class="stat-desc">— Complete process to paint all overlapping COGs onto a sub-tile (Subtiles: ${payload.bench.drapeBuild.subtiles})</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">DEM Terrain Fetch</span>
        <span class="stat-value">${payload.bench.terrainFetch.avgMs} ms</span>
        <span class="stat-desc">— Fetching raw elevation JSON tiles from /s1m/tiles (Tiles: ${payload.bench.terrainFetch.tiles})</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">CPU Mesh Build</span>
        <span class="stat-value">${payload.bench.mesh.avgMs} ms</span>
        <span class="stat-desc">— Decoding elevation arrays and constructing 3D meshes (Tiles: ${payload.bench.mesh.tiles})</span>
      </div>

      <div class="section-title">Memory & Caches</div>
      <div class="stat-line">
        <span class="stat-label">Browser JS Heap</span>
        <span class="stat-value">${memory.browserHeap.available ? `${memory.browserHeap.usedJSHeapSize.label} used` : "Unavailable"}</span>
        <span class="stat-desc">— ${memory.browserHeap.available ? `${memory.browserHeap.totalJSHeapSize.label} allocated, ${memory.browserHeap.jsHeapSizeLimit.label} limit` : memory.browserHeap.note}</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Tracked Decoded/Chunk Bytes</span>
        <span class="stat-value">${memory.totals.trackedDecodedAndChunkBytes.label}</span>
        <span class="stat-desc">— Exact typed-array/ImageData/chunk-cache bytes currently tracked by the viewer</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Estimated String/Ref Bytes</span>
        <span class="stat-value">${memory.totals.estimatedStringAndReferenceBytes.label}</span>
        <span class="stat-desc">— Shallow string/reference estimate; excludes object and Map overhead</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Search Result Features</span>
        <span class="stat-value">${memory.searchResults.count.toLocaleString()} (${memory.searchResults.shallowEstimate.label})</span>
        <span class="stat-desc">— Full /search feature array retained client-side; deep JSON estimate available via window.__cacheMemoryReport({deep: true})</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Mosaic Imagery Sources</span>
        <span class="stat-value">${memory.imagery.deckMosaic.sourceCount.toLocaleString()}</span>
        <span class="stat-desc">— Sources passed to deck.gl MosaicLayer; Flatbush/tile/GPU bytes are not exposed</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Signed URL Cache</span>
        <span class="stat-value">${memory.signedUrls.entries.toLocaleString()} (${memory.signedUrls.estimatedStrings.label})</span>
        <span class="stat-desc">— ${memory.signedUrls.inflight} in-flight, ${memory.signedUrls.expired} expired; UTF-16 URL string payload only</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Drape Images Cache</span>
        <span class="stat-value">${payload.bench.cacheSizes.drapeImages}/${payload.bench.cacheSizes.drapeImageMax} (${memory.s1mDrapeImages.resolvedBytes.label})</span>
        <span class="stat-desc">— Resolved ImageData bytes; configured cap ${memory.s1mDrapeImages.configuredMaxBytes.label}; evictions ${payload.bench.cacheEvictions.drapeImages}</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">COG Tiles Cache</span>
        <span class="stat-value">${payload.bench.cacheSizes.decodedCogTiles}/${payload.bench.cacheSizes.decodedCogTileMax} (${memory.s1mDecodedCogTiles.resolvedBytes.label})</span>
        <span class="stat-desc">— Resolved decoded RGBA bytes; evictions ${payload.bench.cacheEvictions.decodedCogTiles}</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">TIFF Sources Cache</span>
        <span class="stat-value">${payload.bench.cacheSizes.geotiffSources}/${payload.bench.cacheSizes.geotiffSourceMax} (${memory.geotiffSources.chunkCache.memory.label})</span>
        <span class="stat-desc">— Opened imagery GeoTIFF handles; chunk-cache memory only; evictions ${payload.bench.cacheEvictions.geotiffSources}</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">S1M DEM GeoTIFFs</span>
        <span class="stat-value">${memory.s1mGeotiffs.entries.toLocaleString()} (${memory.s1mGeotiffs.chunkCache.memory.label})</span>
        <span class="stat-desc">— DEM COG handles are currently unbounded; chunk-cache memory cap ${memory.s1mGeotiffs.chunkCache.memoryMax.label}</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">S1M Terrain Cache</span>
        <span class="stat-value">${memory.s1mTerrain.entries.toLocaleString()} tiles / ${memory.s1mTerrain.subtiles.toLocaleString()} subtiles (${memory.s1mTerrain.meshAndElevation.label})</span>
        <span class="stat-desc">— Elevation + mesh typed arrays; attached drape ImageData ${memory.s1mTerrain.attachedDrapeImages.label}</span>
      </div>
      <div class="stat-line">
        <span class="stat-label">Drape Source Queries</span>
        <span class="stat-value">${memory.s1mDrapeSourceQueries.entries}/${memory.s1mDrapeSourceQueries.maxEntries} (${memory.s1mDrapeSourceQueries.shallowEstimate.label})</span>
        <span class="stat-desc">— Cached /search bbox query results for terrain drape source selection</span>
      </div>
    `;

    s1mStatsWindow.document.getElementById("stats-display").innerHTML =
      displayHtml;
    s1mStatsWindow.document.getElementById("stats").textContent = text;
    s1mStatsWindow.document.getElementById("stamp").textContent =
      payload.generatedAt;
    s1mStatsWindow.__s1mStatsText = text;
  };
  s1mStatsWindow.document.getElementById("copy").onclick = () => {
    s1mStatsWindow.navigator.clipboard?.writeText(
      s1mStatsWindow.__s1mStatsText || "",
    );
  };
  s1mStatsWindow.document.getElementById("reset").onclick = () => {
    s1mBenchReset();
    render();
  };
  if (s1mStatsWindowTimer) {
    clearInterval(s1mStatsWindowTimer);
  }
  render();
  s1mStatsWindowTimer = setInterval(() => {
    if (!s1mStatsWindow || s1mStatsWindow.closed) {
      clearInterval(s1mStatsWindowTimer);
      s1mStatsWindowTimer = null;
      return;
    }
    render();
  }, 1000);
  return s1mStatsWindow;
}
if (typeof window !== "undefined") {
  window.__s1mBench = s1mBench;
  window.__s1mBenchReport = s1mBenchReport;
  window.__s1mBenchReset = s1mBenchReset;
  window.__s1mFillMetrics = s1mFillMetrics;
  window.__s1mFillReport = s1mFillReport;
  window.__s1mOpenStatsWindow = s1mOpenStatsWindow;
  window.__cacheMemoryReport = cacheMemoryReport;
}
// Memoized filtered views of lastSearchFeatures. Recreated only when
// lastSearchFeatures changes, so MosaicLayer sees a stable array
// reference across updateImageryLayers() calls triggered by panning.
let _memoFeaturesRef = null;
let _memoImagerySources = [];
function getImagerySources() {
  if (lastSearchFeatures !== _memoFeaturesRef) {
    _memoFeaturesRef = lastSearchFeatures;
    _memoImagerySources = lastSearchFeatures.filter(
      (feature) => feature?.assets?.image?.href && Array.isArray(feature?.bbox),
    );
  }
  return _memoImagerySources;
}
function getTerrainDrapeSources() {
  return s1mDrapeSourceKey ? s1mDrapeSources : getImagerySources();
}
function s1mDrapeSourceCacheStats() {
  let pending = 0,
    ready = 0,
    failed = 0,
    sources = 0,
    rawSources = 0;
  for (const entry of s1mDrapeSourceCache.values()) {
    if (entry.pending) {
      pending += 1;
    }
    if (entry.sources) {
      ready += 1;
      sources += entry.sources.length;
      rawSources += entry.rawCount || entry.sources.length;
    }
    if (entry.error) {
      failed += 1;
    }
  }
  return { pending, ready, failed, sources, rawSources };
}
function clearS1MDrapeSourceCache() {
  s1mDrapeSourceCache.clear();
  s1mDrapeSourceKey = null;
  s1mDrapeSources = [];
  s1mDrapeSourcePending = null;
  s1mDrapeSourceError = null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown";
  }
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (abs >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (abs >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

function byteReport(bytes) {
  const safeBytes = Number.isFinite(bytes)
    ? Math.max(0, Math.round(bytes))
    : null;
  return {
    bytes: safeBytes,
    mb: safeBytes === null ? null : +(safeBytes / (1024 * 1024)).toFixed(2),
    label: safeBytes === null ? "unknown" : formatBytes(safeBytes),
  };
}

function jsStringBytes(value) {
  return typeof value === "string" ? value.length * 2 : 0;
}

function sumNumberValues(map) {
  let total = 0;
  for (const value of map.values()) {
    if (Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

function typedArrayBytes(value, seen = null) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isFinite(value.byteLength)
  ) {
    return 0;
  }
  const token =
    value.buffer && typeof value.buffer === "object" ? value.buffer : value;
  if (seen && token) {
    if (seen.has(token)) {
      return 0;
    }
    seen.add(token);
  }
  return value.byteLength;
}

function meshBytes(gpuMesh, seen = null) {
  if (!gpuMesh) {
    return 0;
  }
  const mesh = gpuMesh.mesh || gpuMesh;
  let bytes = typedArrayBytes(gpuMesh.positions64Low, seen);
  bytes += typedArrayBytes(mesh?.indices?.value || mesh?.indices, seen);
  for (const attr of Object.values(mesh?.attributes || {})) {
    bytes += typedArrayBytes(attr?.value || attr, seen);
  }
  return bytes;
}

function imageDataBytes(imageData, seen = null) {
  return typedArrayBytes(imageData?.data, seen);
}

function featureReferenceMemory(features, options = {}) {
  const list = Array.isArray(features) ? features : [];
  let hrefBytes = 0;
  let idBytes = 0;
  let bboxNumberBytes = 0;
  let selectedPropertyBytes = 0;
  let imageRefs = 0;
  for (const feature of list) {
    idBytes += jsStringBytes(feature?.id);
    if (Array.isArray(feature?.bbox)) {
      bboxNumberBytes += feature.bbox.length * 8;
    }
    const href = feature?.assets?.image?.href;
    if (href) {
      imageRefs += 1;
      hrefBytes += jsStringBytes(href);
    }
    const props = feature?.properties || {};
    selectedPropertyBytes +=
      jsStringBytes(props.region) +
      jsStringBytes(props.state) +
      jsStringBytes(props["naip:state"]) +
      jsStringBytes(props.datetime) +
      jsStringBytes(String(props.year ?? props["naip:year"] ?? "")) +
      jsStringBytes(String(props["proj:code"] ?? props["proj:epsg"] ?? ""));
  }
  const shallowBytes =
    hrefBytes + idBytes + bboxNumberBytes + selectedPropertyBytes;
  let serializedUtf16Bytes = null;
  if (options.deep === true) {
    try {
      serializedUtf16Bytes = jsStringBytes(JSON.stringify(list));
    } catch (_) {
      serializedUtf16Bytes = null;
    }
  }
  return {
    count: list.length,
    imageRefs,
    shallowEstimate: byteReport(shallowBytes),
    hrefStrings: byteReport(hrefBytes),
    idStrings: byteReport(idBytes),
    bboxNumbers: byteReport(bboxNumberBytes),
    selectedProperties: byteReport(selectedPropertyBytes),
    serializedUtf16: byteReport(serializedUtf16Bytes),
    note:
      options.deep === true
        ? "Serialized UTF-16 is a measurement of a temporary JSON string, not exact live heap."
        : "Default estimate includes href/id strings, bbox numbers, and selected scalar properties; pass {deep: true} to include temporary serialized JSON size.",
  };
}

function signedUrlCacheMemoryReport() {
  const now = Date.now();
  let keyBytes = 0;
  let urlBytes = 0;
  let expired = 0;
  for (const [href, entry] of signedUrlCache.entries()) {
    keyBytes += jsStringBytes(href);
    urlBytes += jsStringBytes(entry?.url);
    if (Number(entry?.expiresAt) <= now) {
      expired += 1;
    }
  }
  return {
    entries: signedUrlCache.size,
    inflight: inflightSigns.size,
    expired,
    keyStrings: byteReport(keyBytes),
    urlStrings: byteReport(urlBytes),
    estimatedStrings: byteReport(keyBytes + urlBytes),
    note: "String bytes are UTF-16 payload estimates only; Map/object overhead is not included.",
  };
}

function imageryReferenceMemoryReport(options = {}) {
  const imagerySources = getImagerySources();
  const hrefBytes = currentImageryHrefs.reduce(
    (sum, href) => sum + jsStringBytes(href),
    0,
  );
  return {
    currentImageryHrefs: {
      count: currentImageryHrefs.length,
      strings: byteReport(hrefBytes),
    },
    imagerySources: featureReferenceMemory(imagerySources, options),
    signatures: {
      footprint: byteReport(jsStringBytes(currentFootprintSignature)),
      imagery: byteReport(jsStringBytes(currentImagerySignature)),
    },
    deckMosaic: {
      sourceCount: imagerySources.length,
      note: "MosaicLayer also owns a Flatbush index and deck.gl tile-cache objects; those live-object and GPU bytes are not exposed by the browser.",
    },
  };
}

function chunkStatsForGeotiff(geotiff) {
  const source = geotiff?.dataSource;
  if (!source) {
    return null;
  }
  let stats = null;
  try {
    stats = typeof source.stats === "function" ? source.stats() : null;
  } catch (_) {
    stats = null;
  }
  const memoryBytes = Number(stats?.memoryBytes ?? source.memoryBytes);
  const memoryMaxBytes = Number(stats?.memoryMaxBytes ?? source.memoryMaxBytes);
  const memoryEntries = Number(stats?.memoryEntries ?? source.memory?.size);
  const inflight = Number(stats?.inflight ?? source.inflight?.size);
  if (
    !Number.isFinite(memoryBytes) &&
    !Number.isFinite(memoryMaxBytes) &&
    !Number.isFinite(memoryEntries) &&
    !stats
  ) {
    return null;
  }
  return {
    memoryBytes: Number.isFinite(memoryBytes) ? memoryBytes : 0,
    memoryMaxBytes: Number.isFinite(memoryMaxBytes) ? memoryMaxBytes : 0,
    memoryEntries: Number.isFinite(memoryEntries) ? memoryEntries : 0,
    inflight: Number.isFinite(inflight) ? inflight : 0,
    memoryHits: Number(stats?.memoryHits || 0),
    persistentHits: Number(stats?.persistentHits || 0),
    misses: Number(stats?.misses || 0),
    networkBytes: Number(stats?.networkBytes || 0),
    requestedBytes: Number(stats?.requestedBytes || 0),
  };
}

function aggregateChunkStats(resolvedGeotiffs) {
  const totals = {
    sources: resolvedGeotiffs.size,
    chunkCacheSources: 0,
    memoryBytes: 0,
    memoryMaxBytes: 0,
    memoryEntries: 0,
    inflight: 0,
    memoryHits: 0,
    persistentHits: 0,
    misses: 0,
    networkBytes: 0,
    requestedBytes: 0,
  };
  for (const geotiff of resolvedGeotiffs.values()) {
    const stats = chunkStatsForGeotiff(geotiff);
    if (!stats) {
      continue;
    }
    totals.chunkCacheSources += 1;
    totals.memoryBytes += stats.memoryBytes;
    totals.memoryMaxBytes += stats.memoryMaxBytes;
    totals.memoryEntries += stats.memoryEntries;
    totals.inflight += stats.inflight;
    totals.memoryHits += stats.memoryHits;
    totals.persistentHits += stats.persistentHits;
    totals.misses += stats.misses;
    totals.networkBytes += stats.networkBytes;
    totals.requestedBytes += stats.requestedBytes;
  }
  return {
    ...totals,
    memory: byteReport(totals.memoryBytes),
    memoryMax: byteReport(totals.memoryMaxBytes),
    network: byteReport(totals.networkBytes),
    requested: byteReport(totals.requestedBytes),
  };
}

function geotiffHandleCacheMemoryReport(cache, resolved, maxEntries = null) {
  let keyBytes = 0;
  for (const key of cache.keys()) {
    keyBytes += jsStringBytes(key);
  }
  return {
    entries: cache.size,
    maxEntries,
    resolved: resolved.size,
    keyStrings: byteReport(keyBytes),
    chunkCache: aggregateChunkStats(resolved),
    note: "GeoTIFF object/header-cache and decoder internals are not fully measurable; chunk-cache byte counts are exact for the wrapped tile-data chunk cache.",
  };
}

function s1mTerrainCacheMemoryReport() {
  const seen = new WeakSet();
  let cacheKeyBytes = 0;
  let rootElevationBytes = 0;
  let rootMeshBytes = 0;
  let subtileElevationBytes = 0;
  let subtileMeshBytes = 0;
  let attachedDrapeBytes = 0;
  let subtiles = 0;
  let texturedSubtiles = 0;
  for (const [key, cache] of s1mTileCache.entries()) {
    cacheKeyBytes += jsStringBytes(key);
    rootElevationBytes += typedArrayBytes(cache?.elevations, seen);
    rootElevationBytes += typedArrayBytes(cache?.data?.elev, seen);
    rootMeshBytes += meshBytes(cache?.gpuMesh, seen);
    for (const sub of cache?.subtiles?.values?.() || []) {
      subtiles += 1;
      if (sub.drapeImage) {
        texturedSubtiles += 1;
      }
      subtileElevationBytes += typedArrayBytes(sub.elev, seen);
      subtileMeshBytes += meshBytes(sub.gpuMesh, seen);
      attachedDrapeBytes += imageDataBytes(sub.drapeImage, seen);
    }
  }
  const meshAndElevationBytes =
    rootElevationBytes +
    rootMeshBytes +
    subtileElevationBytes +
    subtileMeshBytes;
  return {
    entries: s1mTileCache.size,
    activeTiles: s1mActiveTiles.size,
    subtiles,
    texturedSubtiles,
    keyStrings: byteReport(cacheKeyBytes),
    rootElevations: byteReport(rootElevationBytes),
    rootMeshes: byteReport(rootMeshBytes),
    subtileElevations: byteReport(subtileElevationBytes),
    subtileMeshes: byteReport(subtileMeshBytes),
    meshAndElevation: byteReport(meshAndElevationBytes),
    attachedDrapeImages: byteReport(attachedDrapeBytes),
    totalIncludingAttachedDrapes: byteReport(
      meshAndElevationBytes + attachedDrapeBytes,
    ),
    note: "Mesh/elevation bytes are typed-array payloads retained by the JS objects; deck.gl/WebGL buffer copies are not exposed.",
  };
}

function s1mDrapeImageCacheMemoryReport() {
  const configuredMaxBytes =
    S1M_DRAPE_CACHE_MAX * S1M_SUBTILE_DRAPE_SIZE * S1M_SUBTILE_DRAPE_SIZE * 4;
  return {
    entries: s1mDrapeCache.size,
    maxEntries: S1M_DRAPE_CACHE_MAX,
    resolvedEntries: s1mDrapeCacheBytes.size,
    resolvedBytes: byteReport(sumNumberValues(s1mDrapeCacheBytes)),
    configuredMaxBytes: byteReport(configuredMaxBytes),
    textureSizePx: S1M_SUBTILE_DRAPE_SIZE,
    note: "Resolved bytes are exact ImageData RGBA payloads. Browser/GPU texture copies are not included.",
  };
}

function s1mDecodedCogTileCacheMemoryReport() {
  return {
    entries: s1mCogTileCache.size,
    maxEntries: S1M_COG_TILE_CACHE_MAX_COUNT,
    resolvedEntries: s1mCogTileCacheBytes.size,
    resolvedBytes: byteReport(sumNumberValues(s1mCogTileCacheBytes)),
    note: "Resolved bytes are exact decoded RGBA typed-array payloads for COG tiles used while building drapes.",
  };
}

function s1mDrapeSourceQueryMemoryReport() {
  let keyBytes = 0;
  let bboxBytes = 0;
  let hrefBytes = 0;
  let idBytes = 0;
  let errorBytes = 0;
  let sourceRefs = 0;
  for (const [key, entry] of s1mDrapeSourceCache.entries()) {
    keyBytes += jsStringBytes(key);
    if (Array.isArray(entry?.bbox)) {
      bboxBytes += entry.bbox.length * 8;
    }
    errorBytes += jsStringBytes(entry?.error);
    for (const source of entry?.sources || []) {
      sourceRefs += 1;
      hrefBytes += jsStringBytes(source?.assets?.image?.href);
      idBytes += jsStringBytes(source?.id);
      if (Array.isArray(source?.bbox)) {
        bboxBytes += source.bbox.length * 8;
      }
    }
  }
  const sourceStats = s1mDrapeSourceCacheStats();
  return {
    entries: s1mDrapeSourceCache.size,
    maxEntries: S1M_DRAPE_SOURCE_CACHE_MAX,
    ready: sourceStats.ready,
    pending: sourceStats.pending,
    failed: sourceStats.failed,
    sourceRefs,
    rawSources: sourceStats.rawSources,
    shallowEstimate: byteReport(
      keyBytes + bboxBytes + hrefBytes + idBytes + errorBytes,
    ),
    keyStrings: byteReport(keyBytes),
    hrefStrings: byteReport(hrefBytes),
    idStrings: byteReport(idBytes),
    bboxNumbers: byteReport(bboxBytes),
    errorStrings: byteReport(errorBytes),
  };
}

function browserHeapMemoryReport() {
  const memory = performance?.memory;
  if (!memory) {
    return {
      available: false,
      note: "performance.memory is not available in this browser context.",
    };
  }
  return {
    available: true,
    usedJSHeapSize: byteReport(memory.usedJSHeapSize),
    totalJSHeapSize: byteReport(memory.totalJSHeapSize),
    jsHeapSizeLimit: byteReport(memory.jsHeapSizeLimit),
    note: "Browser heap numbers are coarse and Chrome-specific.",
  };
}

function cacheMemoryReport(options = {}) {
  const signedUrls = signedUrlCacheMemoryReport();
  const searchResults = featureReferenceMemory(lastSearchFeatures, options);
  const imagery = imageryReferenceMemoryReport(options);
  const geotiffSources = geotiffHandleCacheMemoryReport(
    geotiffSourceCache,
    geotiffSourceResolved,
    GEOTIFF_SOURCE_CACHE_MAX,
  );
  const s1mGeotiffs = geotiffHandleCacheMemoryReport(
    s1mGeotiffCache,
    s1mGeotiffResolved,
    null,
  );
  const s1mTerrain = s1mTerrainCacheMemoryReport();
  const s1mDrapeImages = s1mDrapeImageCacheMemoryReport();
  const s1mDecodedCogTiles = s1mDecodedCogTileCacheMemoryReport();
  const s1mDrapeSourceQueries = s1mDrapeSourceQueryMemoryReport();
  const trackedBytes =
    (s1mTerrain.meshAndElevation.bytes || 0) +
    (s1mDrapeImages.resolvedBytes.bytes || 0) +
    (s1mDecodedCogTiles.resolvedBytes.bytes || 0) +
    (geotiffSources.chunkCache.memory.bytes || 0) +
    (s1mGeotiffs.chunkCache.memory.bytes || 0);
  const estimatedStringBytes =
    (signedUrls.estimatedStrings.bytes || 0) +
    (searchResults.shallowEstimate.bytes || 0) +
    (imagery.currentImageryHrefs.strings.bytes || 0) +
    (imagery.signatures.footprint.bytes || 0) +
    (imagery.signatures.imagery.bytes || 0) +
    (geotiffSources.keyStrings.bytes || 0) +
    (s1mGeotiffs.keyStrings.bytes || 0) +
    (s1mDrapeSourceQueries.shallowEstimate.bytes || 0);
  return {
    generatedAt: new Date().toISOString(),
    browserHeap: browserHeapMemoryReport(),
    totals: {
      trackedDecodedAndChunkBytes: byteReport(trackedBytes),
      estimatedStringAndReferenceBytes: byteReport(estimatedStringBytes),
      caveats: [
        "Exact per-object heap size is not exposed by JavaScript.",
        "Map/object/Promise overhead, MapLibre worker copies, Flatbush index internals, deck.gl tile objects, decoder internals, and GPU texture/buffer copies are not included.",
        "Deep serialized size is intentionally off by default because it allocates a temporary JSON string.",
      ],
    },
    signedUrls,
    searchResults,
    imagery,
    geotiffSources,
    s1mGeotiffs,
    s1mTerrain,
    s1mDrapeImages,
    s1mDecodedCogTiles,
    s1mDrapeSourceQueries,
  };
}

function resetS1MDrapeMetrics() {
  s1mDrapeMetrics.mode = "analytic RGBIR";
  s1mDrapeMetrics.sourceSearchMs = null;
  s1mDrapeMetrics.sourceRawCount = 0;
  s1mDrapeMetrics.sourceCount = 0;
  s1mDrapeMetrics.sourceError = null;
  s1mDrapeMetrics.tilesStarted = 0;
  s1mDrapeMetrics.tilesCompleted = 0;
  s1mDrapeMetrics.tilesFailed = 0;
  s1mDrapeMetrics.tileSourceRefs = 0;
  s1mDrapeMetrics.analyticRefs = 0;
  s1mDrapeMetrics.totalTileMs = 0;
  s1mDrapeMetrics.lastTileMs = null;
  s1mDrapeMetrics.lastSourceRefs = 0;
  s1mDrapeMetrics.maxSourceRefs = 0;
  s1mDrapeMetrics.noDataSourceFallbacks = 0;
  s1mDrapeMetrics.lastHref = null;
  renderS1MDrapeMetrics();
}
function fmtMs(value) {
  return Number.isFinite(value)
    ? `${value.toFixed(value >= 100 ? 0 : 1)} ms`
    : "-";
}
function fmtPct(value, max) {
  return max ? `${Math.round((100 * value) / max)}%` : "-";
}
function renderS1MDrapeMetrics() {
  const el = document.getElementById("ter-metrics");
  if (!el) {
    return;
  }
  const avgTileMs = s1mDrapeMetrics.tilesCompleted
    ? s1mDrapeMetrics.totalTileMs / s1mDrapeMetrics.tilesCompleted
    : null;
  const avgRefs = s1mDrapeMetrics.tilesStarted
    ? s1mDrapeMetrics.tileSourceRefs / s1mDrapeMetrics.tilesStarted
    : null;
  const errorText = s1mDrapeMetrics.sourceError
    ? ` · source error: ${s1mDrapeMetrics.sourceError}`
    : "";
  const bucketText = ` · analytic refs ${s1mDrapeMetrics.analyticRefs}`;
  const sourceStats = s1mDrapeSourceCacheStats();
  const sourceQueryText = ` · source bboxes ${sourceStats.ready}/${s1mDrapeSourceCache.size} ready (${sourceStats.pending} pending, ${sourceStats.failed} failed)`;
  const textureText = ` · ${S1M_SUBTILE_DRAPE_SIZE}px sub-tiles (≤${s1mSubdivMax()}×) · sources ${s1mInitialDrapeSourcesPerTile()}/${s1mMaxDrapeSourcesPerTile()}`;
  const cacheText =
    ` · cache drape ${s1mDrapeCache.size}/${S1M_DRAPE_CACHE_MAX} (${fmtPct(s1mDrapeCache.size, S1M_DRAPE_CACHE_MAX)})` +
    ` · COG ${s1mCogTileCache.size} tiles (${(s1mCogTileCacheByteTotal / (1024 * 1024)).toFixed(0)}/${S1M_COG_TILE_CACHE_MAX_BYTES / (1024 * 1024)} MB)` +
    ` · TIFF ${geotiffSourceCache.size}/${GEOTIFF_SOURCE_CACHE_MAX} (${fmtPct(geotiffSourceCache.size, GEOTIFF_SOURCE_CACHE_MAX)})` +
    ` · evict d/c/t ${s1mBench.drapeEvict}/${s1mBench.cogEvict}/${s1mBench.tiffEvict}`;
  const avgSignMs = s1mBench.tiffSignN
    ? s1mBench.tiffSignMs / s1mBench.tiffSignN
    : null;
  const avgResolveMs = s1mBench.tiffResolveN
    ? s1mBench.tiffResolveMs / s1mBench.tiffResolveN
    : null;
  const avgCogFetchMs = s1mBench.cogFetchN
    ? s1mBench.cogFetchMs / s1mBench.cogFetchN
    : null;
  const avgDecodeMs = s1mBench.decodeN
    ? s1mBench.decodeMs / s1mBench.decodeN
    : null;
  const avgRasterMs = s1mBench.rasterN
    ? s1mBench.rasterMs / s1mBench.rasterN
    : null;

  const breakdownText =
    ` · avg sign ${fmtMs(avgSignMs)} (${s1mBench.tiffSignN} calls)` +
    ` · avg hdr ${fmtMs(avgResolveMs)} (${s1mBench.tiffResolveN} sources)` +
    ` · avg tile-get ${fmtMs(avgCogFetchMs)} (${s1mBench.cogFetchN} tiles)` +
    ` · avg decode ${fmtMs(avgDecodeMs)}` +
    ` · avg raster ${fmtMs(avgRasterMs)}`;

  const hrefText = s1mDrapeMetrics.lastHref
    ? ` · last ${s1mDrapeMetrics.lastHref}`
    : "";
  el.textContent =
    `Drape ${s1mDrapeMetrics.mode} · source search ${fmtMs(s1mDrapeMetrics.sourceSearchMs)}` +
    ` · sources ${s1mDrapeMetrics.sourceCount}/${s1mDrapeMetrics.sourceRawCount}` +
    ` · tiles ${s1mDrapeMetrics.tilesCompleted}/${s1mDrapeMetrics.tilesStarted}` +
    ` (${s1mDrapeMetrics.tilesFailed} failed)` +
    ` · avg tile ${fmtMs(avgTileMs)}` +
    ` · last tile ${fmtMs(s1mDrapeMetrics.lastTileMs)}` +
    breakdownText +
    ` · avg sources/tile ${Number.isFinite(avgRefs) ? avgRefs.toFixed(1) : "-"}` +
    ` · max sources/tile ${s1mDrapeMetrics.maxSourceRefs}` +
    ` · no-data fallback ${s1mDrapeMetrics.noDataSourceFallbacks}` +
    bucketText +
    sourceQueryText +
    textureText +
    cacheText +
    hrefText +
    errorText;
}
let imageryInitErrorMessage = null;
const SetAlpha1Module = {
  name: "set-alpha-1",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
      color = vec4(color.rgb, 1.0);
    `,
  },
};
const DisplayAdjustmentsModule = {
  name: "displayAdjustments",
  fs: `
    uniform displayAdjustmentsUniforms {
      float brightness;
      float contrast;
    } displayAdjustments;
  `,
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
      color.rgb = clamp(
        (color.rgb - 0.5) * displayAdjustments.contrast
          + 0.5
          + displayAdjustments.brightness,
        0.0,
        1.0
      );
    `,
  },
  uniformTypes: {
    brightness: "f32",
    contrast: "f32",
  },
  getUniforms: (props = {}) => ({
    brightness: props.brightness ?? 0,
    contrast: props.contrast ?? 1,
  }),
};
// Shared mutable uniform props. Existing tile render pipelines retain this
// object, so controls can redraw cached textures without rebuilding the
// MosaicLayer or invalidating tile fetches.
const displayAdjustmentProps = {
  brightness: 0,
  contrast: 1,
};
function getDisplayAdjustments() {
  return displayAdjustmentProps;
}

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(
  {
    onAdd() {
      layerNumberControlEl = document.createElement("div");
      layerNumberControlEl.className = "maplibregl-ctrl layer-number-control";
      updateLayerNumberControl();
      return layerNumberControlEl;
    },
    onRemove() {
      layerNumberControlEl?.remove();
      layerNumberControlEl = null;
    },
  },
  "top-right",
);

function mapMetersPerPixel() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  return (
    (156543.03392804097 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom
  );
}

function currentViewerTileLayerNumber() {
  const zoom = map.getZoom();
  if (typeof zoom !== "number" || Number.isNaN(zoom)) {
    return 14;
  }
  return Math.max(0, Math.min(29, Math.round(zoom)));
}

function currentDominantCartoCanonicalZ() {
  const counts = new Map();
  for (const [, sourceCache] of getBasemapSourceCacheEntries()) {
    const ids =
      typeof sourceCache.getRenderableIds === "function"
        ? sourceCache.getRenderableIds()
        : Object.keys(sourceCache._tiles || {});
    for (const id of ids) {
      const tile =
        typeof sourceCache.getTileByID === "function"
          ? sourceCache.getTileByID(id)
          : sourceCache._tiles?.[id];
      const canonicalZ = tile?.tileID?.canonical?.z;
      if (!Number.isFinite(canonicalZ)) {
        continue;
      }
      counts.set(canonicalZ, (counts.get(canonicalZ) || 0) + 1);
    }
  }
  let bestZ = null;
  let bestCount = -1;
  for (const [z, count] of counts.entries()) {
    if (count > bestCount) {
      bestZ = z;
      bestCount = count;
    }
  }
  return bestZ;
}

function updateLayerNumberControl() {
  if (!layerNumberControlEl) {
    return;
  }
  const viewerZ = currentViewerTileLayerNumber();
  const cartoZ = currentDominantCartoCanonicalZ();
  layerNumberControlEl.innerHTML = `
    <div>Layer z ${viewerZ}</div>
    <div>Carto z ${cartoZ ?? "?"}</div>
  `;
}

/**
 * Check whether the current viewport is fully covered by the bounding
 * box union of the given STAC features.  Uses the envelope (bounding box
 * of all feature bboxes) as a fast conservative test — if the envelope
 * contains the viewport, every visible pixel is inside at least one
 * feature's extent, so a new search would not add coverage.
 */
function footprintsCoverViewport(features) {
  if (!lastSearchBbox || !features || features.length === 0) {
    return false;
  }
  const viewBbox = currentBbox(); // [west, south, east, north]

  // The current viewport must be fully contained within the bounding box of the last successful search
  return (
    lastSearchBbox[0] <= viewBbox[0] &&
    lastSearchBbox[1] <= viewBbox[1] &&
    lastSearchBbox[2] >= viewBbox[2] &&
    lastSearchBbox[3] >= viewBbox[3]
  );
}

// An aborted in-flight tile fetch (pan/zoom cancels deck.gl requests) is
// expected, not an error. The abort can be wrapped -- the thrown error is
// a "Failed to fetch" whose .cause is the AbortError -- so walk the cause
// chain rather than inspecting only the top-level error.
function isAbortLikeError(error) {
  for (let e = error; e; e = e.cause) {
    if (e?.name === "AbortError" || e?.message?.includes("abort")) {
      return true;
    }
  }
  return false;
}

async function resolveGeotiffSource(source, opts = {}) {
  const { signal, concurrencyLimiter, getPriority } = opts;
  // /search now returns the raw s3:// href; sign it on demand here so only
  // tiles deck.gl actually loads get presigned. Cache the decoded GeoTIFF
  // by the stable s3:// key (not the signed URL, which rotates).
  const s3href = source?.assets?.image?.href;
  if (!s3href) {
    return null;
  }
  // Cache the in-flight promise, not just the resolved value: when many
  // drape sub-tiles hit a cold source in the same paint, they share one
  // sign + one header (IFD) read instead of each issuing its own (those
  // header reads otherwise compete with tile reads for the fetch queue).
  // The shared resolve intentionally does not pass the per-caller abort
  // signal into the header read -- like signHref, one caller's pan-abort
  // must not cancel a resolve others are awaiting. Callers still re-check
  // their own signal after the shared resolve completes.
  let pending = geotiffSourceCache.get(s3href);
  if (!pending) {
    pending = (async () => {
      const t0 = performance.now();
      const signedUrl = await signHref(s3href);
      const t1 = performance.now();
      s1mBench.tiffSignMs += t1 - t0;
      s1mBench.tiffSignN += 1;

      const geotiff = await window.GeoTIFFCoreClass.fromUrl(signedUrl, {
        concurrencyLimiter,
        getPriority,
        chunkCache: chunkCacheForHref(s3href),
      });
      const t2 = performance.now();
      s1mBench.tiffResolveMs += t2 - t1;
      s1mBench.tiffResolveN += 1;

      return geotiff;
    })()
      .then((geotiff) => {
        if (geotiffSourceCache.get(s3href) === pending) {
          geotiffSourceResolved.set(s3href, geotiff);
        }
        return geotiff;
      })
      .catch((error) => {
        deleteGeotiffSourceCacheEntry(s3href); // never cache a failed resolve
        // A 403/expired signed URL: drop the cached signature so the next
        // resolve re-signs from scratch.
        if (isExpiredSignatureError(error)) {
          signedUrlCache.delete(s3href);
        }
        console.error("Failed to resolve GeoTIFF source:", source.id, error);
        throw error;
      });
    geotiffSourceCache.set(s3href, pending);
    while (geotiffSourceCache.size > GEOTIFF_SOURCE_CACHE_MAX) {
      deleteGeotiffSourceCacheEntry(geotiffSourceCache.keys().next().value);
      s1mBench.tiffEvict += 1;
    }
  } else {
    geotiffSourceCache.delete(s3href);
    geotiffSourceCache.set(s3href, pending);
  }
  const geotiff = await pending;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const epsg = parseEpsgCode(source?.properties);
  if (Number.isFinite(epsg)) {
    const numericEpsg = Number(epsg);
    geotiff._crs = numericEpsg;
    Object.defineProperty(geotiff, "crs", {
      configurable: true,
      enumerable: false,
      get: () => numericEpsg,
    });
  }
  return geotiff;
}

let normalized16BitTexturesSupported;
function supportsNormalized16BitTextures() {
  if (normalized16BitTexturesSupported === undefined) {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    normalized16BitTexturesSupported = Boolean(
      gl?.getExtension("EXT_texture_norm16"),
    );
  }
  return normalized16BitTexturesSupported;
}

function buildCogSourceLayer({
  source,
  data,
  signal,
  id,
  extent,
  clipBounds = null,
  revision = null,
}) {
  if (!source || !data) {
    return null;
  }

  const activeSignal = signal && !signal.aborted ? signal : undefined;

  // If clipBounds (lng/lat) provided, convert to deck.gl common space for
  // the CutlineBbox GPU module. lngLatToWorld maps [lng,lat] → [x,y] in a
  // 512-px world coordinate system that matches deck.gl common space.
  let cutlineBboxCommon = null;
  if (clipBounds && CutlineBboxModule && lngLatToWorldFn) {
    const [west, south, east, north] = clipBounds;
    const min = lngLatToWorldFn([west, south]);
    const max = lngLatToWorldFn([east, north]);
    cutlineBboxCommon = [min[0], min[1], max[0], max[1]];
  }

  const s3href = source?.assets?.image?.href;
  const collection = s3href ? collectionForHref(s3href) : null;
  const domain = collection?.display?.domain;
  const displayAdjustments = getDisplayAdjustments();
  // Normalized 16-bit textures require EXT_texture_norm16 in WebGL2.
  // Without it, RGBA16 is rejected and subsequent uploads target an
  // unallocated texture, producing a black tile.
  const use16BitTextureFallback = !supportsNormalized16BitTextures();

  return new COGLayerClass({
    id,
    geotiff: data,
    signal: activeSignal,
    extent,
    domain: use16BitTextureFallback ? undefined : domain,
    updateTriggers: {
      getTileData: [revision],
      renderTile: [domain, use16BitTextureFallback],
    },
    getTileData: async (image, options) => {
      let tile;
      try {
        tile = await image.fetchTile(options.x, options.y, {
          signal: options.signal,
          boundless: false,
        });
      } catch (error) {
        if (!isAbortLikeError(error)) {
          console.error(`Failed to fetch tile for ${source.id}:`, error);
        }
        throw error;
      }
      const array = addAlphaChannelFn(tile.array);
      if (array.layout === "band-separate") {
        throw new Error("Expected pixel-interleaved analytic imagery");
      }
      const bitsPerSample = image.cachedTags?.bitsPerSample?.[0] || 8;
      let textureData = array.data;
      let format = bitsPerSample === 16 ? "rgba16unorm" : "rgba8unorm";
      if (
        bitsPerSample === 16 &&
        use16BitTextureFallback &&
        textureData instanceof Uint16Array
      ) {
        const domainMin = Number(domain?.[0] ?? 0);
        const domainMax = Number(domain?.[1] ?? 65535);
        const range = Math.max(1, domainMax - domainMin);
        const displayData = new Uint8Array(textureData.length);
        for (let i = 0; i < textureData.length; i++) {
          const normalized = (textureData[i] - domainMin) / range;
          displayData[i] = Math.round(
            Math.max(0, Math.min(1, normalized)) * 255,
          );
        }
        textureData = displayData;
        format = "rgba8unorm";
      }
      const texture = options.device.createTexture({
        data: textureData,
        format,
        width: array.width,
        height: array.height,
      });
      return {
        texture,
        width: array.width,
        height: array.height,
        byteLength: textureData.byteLength,
      };
    },
    renderTile: (tileData) => {
      const pipeline = [
        {
          module: CreateTextureModule,
          props: { textureName: tileData.texture },
        },
        { module: SetAlpha1Module },
      ];
      // Clip rendering to the TMS tile bounds via GPU fragment discard
      if (cutlineBboxCommon) {
        pipeline.push({
          module: CutlineBboxModule,
          props: { bbox: cutlineBboxCommon },
        });
      }
      pipeline.push({
        module: DisplayAdjustmentsModule,
        props: displayAdjustments,
      });
      return { renderPipeline: pipeline };
    },
    onTileError: (error) => {
      if (!isAbortLikeError(error)) {
        console.error("COGLayer tile load error:", source.id, error);
      }
    },
  });
}

// S1M terrain: /s1m/tiles returns the tiles intersecting the viewport and
// /s1m/terrain returns each tile's downsampled elevation grid, which we
// mesh (GPU TerrainMeshLayer, or CPU SimpleMeshLayer) anchored at the tile
// centre (METER_OFFSETS) so tiles abut. Drawn as 3D terrain, never imagery.
let SimpleMeshLayerClass = null;
let TerrainMeshLayerClass = null; // package GPU-displacement terrain (option B)
let PathLayerClass = null;
let s1mActiveTiles = new Map();
let S1M_COORD = null;
let s1mDrapeConcurrencyLimiter = null;
let s1mActive = false; // terrain mode on (refreshes on pan/zoom)
let s1mLayers = []; // tile layers currently pushed to deck
const s1mTileCache = new Map(); // `${dataset}@${size}` -> {data, elevations, gpuMesh, layer}
const s1mDrapeCache = new Map(); // drape key -> Promise<ImageData>
const s1mDrapeCacheBytes = new Map(); // drape key -> resolved ImageData.data.byteLength
const s1mDrapedSubdivByDataset = new Map(); // dataset -> finest subdiv actually draped; the drape resolution only ratchets up (zoom-out keeps the finer drape, never re-drapes coarser)
window.__s1mDrapeRatchet = s1mDrapedSubdivByDataset; // debug handle (like window.__map) for scripted checks
const S1M_FOOTPRINT_MIN_Z = 3;
let s1mFootprintTiles = [];
let s1mFootprintKey = "";
let s1mFootprintPendingKey = "";
let s1mFootprintSeq = 0;
const NAIP_COVERAGE_MVT_MIN_Z = 3;
const NAIP_COVERAGE_MVT_MAX_SOURCE_Z = 15;
const _NAIP_COVERAGE_MVT_MAX_RENDER_Z = 24;
const NAIP_COVERAGE_MVT_SOURCE_ID = "naip-coverage-mvt";
const NAIP_COVERAGE_MVT_LAYER_ID = "naip-coverage-mvt-footprints";
const NAIP_COVERAGE_MVT_LINE_LAYER_ID = "naip-coverage-mvt-footprint-lines";
const NAIP_COVERAGE_MVT_VERSION = "footprints-v2";
const NAIP_COVERAGE_FOOTPRINT_RGBA = [251, 146, 60]; // matches the old search-result outline orange
const SEARCH_RESULT_FOOTPRINT_COLOR = "#22c55e";
const S1M_MAX_TILES = 96; // enough to cover wide/pitched views; LOD keeps edge tiles cheap
// Collections whose source COGs are small (~1-2 km) relative to a ~12 km
// S1M tile. One drape sub-tile can span dozens of them, so they need finer
// sub-tiling (s1mSubdiv) AND a higher per-sub-tile source cap; otherwise a
// sub-tile hits the cap before it's covered and leaves undraped gaps.
function isSmallCogCollection(col = activeCollection()) {
  return col === "nj-imagery" || col === "kyfromabove";
}
function s1mInitialDrapeSourcesPerTile() {
  return isSmallCogCollection() ? 24 : 6;
}
function s1mMaxDrapeSourcesPerTile() {
  return isSmallCogCollection() ? 48 : 12;
}
const S1M_SUBTILE_DRAPE_SIZE = 384; // per imagery drape sub-tile; effective res = subdiv × this
const S1M_SUBDIV_MAX_HI = 32; // ceiling when few S1M tiles fill the view (very zoomed in): sub-tile ~12km/32 ~= 375m -> 384px tex ~= 1 m/px (vs ~5 m/px at subdiv 6)
// Per-tile N×N drape sub-tiling cap, RESPONSIVE to how many S1M tiles fill the
// viewport. Zoomed in, few tiles -> spare texture budget, so allow finer
// sub-tiling (each sub-tile reads a finer COG overview -> sharper imagery)
// without growing memory: the viewport cull keeps the BUILT sub-tile count
// ~constant (a tiny viewport spans only a few of the now-smaller sub-tiles).
// Zoomed out, many tiles -> keep the original cap of 6 so low-zoom memory is
// unchanged. This cap also bounds the drape ratchet on zoom-out (clamped in
// s1mBuildTileLayers) so a deep zoom-in can't leave runaway fine subdivision.
function s1mSubdivMax() {
  const t = s1mActiveTiles.size || 1;
  if (t <= 2) {
    return S1M_SUBDIV_MAX_HI;
  }
  if (t <= 6) {
    return 16;
  }
  if (t <= 16) {
    return 8;
  }
  return 6;
}
const S1M_DRAPE_CACHE_MAX = 96; // 384px RGBA ImageData ~= 0.56 MB each (~54 MB); roomy enough that finer small-COG sub-tiling (NJ/KY, subdiv>=2) doesn't thrash on pan
// NJ/KY imagery is many small COGs (~1.5 km) vs a ~12 km S1M DEM tile, so at
// low zoom one tile would need dozens of COGs to drape -- slow and gap-prone.
// Defer the imagery drape for small-COG collections until this zoom; below it
// the terrain renders shaded (with a status hint) instead of a confusing
// partial drape, then switches to imagery once the user is zoomed in enough.
const S1M_SMALL_COG_DRAPE_MIN_ZOOM = 13;
// Single source of truth for "should imagery be draped on the terrain right
// now": the surface control must be "imagery", and small-COG collections also
// require zoom >= the threshold. Used at every drape-decision point.
function drapeImageryActive() {
  if (document.getElementById("ter-surface")?.value !== "imagery") {
    return false;
  }
  if (
    isSmallCogCollection() &&
    (map.getZoom() || 0) < S1M_SMALL_COG_DRAPE_MIN_ZOOM
  ) {
    return false;
  }
  return true;
}
const S1M_DRAPE_SOURCE_CACHE_MAX = 192; // one small /search result per rendered S1M bbox
const s1mTerrainPending = new Map(); // tile key -> {seq, dataset, size, startedAt}
const s1mTerrainFailures = new Map(); // tile key -> {seq, dataset, size, message, at}
let s1mMoveHandler = null;
let s1mRefreshSeq = 0; // guards against stale async refreshes
let buildingFootprintSeq = 0;
let buildingFootprintKey = "";
let buildingFeatureData = null; // raw lon/lat FC from the API, pre terrain-seating
const BUILDING_MAX_FEATURES = 12000; // viewport-scoped, so this is only a safety cap

function deleteS1MDrapeCacheEntry(key) {
  if (!key) {
    return;
  }
  s1mDrapeCache.delete(key);
  s1mDrapeCacheBytes.delete(key);
}

function clearS1MDrapeCacheEntries() {
  s1mDrapeCache.clear();
  s1mDrapeCacheBytes.clear();
}

function moveMapLibreVectorLayersToTop() {
  const orderedLayerIds = [
    "naip-search-fill",
    "naip-search-line",
    NAIP_COVERAGE_MVT_LAYER_ID,
    NAIP_COVERAGE_MVT_LINE_LAYER_ID,
    "overture-buildings-fill",
  ];
  for (const layerId of orderedLayerIds) {
    if (map.getLayer(layerId)) {
      map.moveLayer(layerId);
    }
  }
}

function s1mCachedForDesired(key, tile) {
  const exact = s1mTileCache.get(key);
  if (exact) {
    return { cacheKey: key, cache: exact, exact: true };
  }
  for (const cacheKey of s1mTileCache.keys()) {
    if (cacheKey.startsWith(`${tile.dataset}@`)) {
      return { cacheKey, cache: s1mTileCache.get(cacheKey), exact: false };
    }
  }
  return { cacheKey: null, cache: null, exact: false };
}

function s1mFillReport() {
  const now = performance.now();
  const notFilled = [];
  const staleLod = [];
  let exactCached = 0,
    fallbackCached = 0,
    missing = 0;
  let drapeTotal = 0,
    drapeTextured = 0,
    drapePending = 0,
    drapeRefreshing = 0,
    drapeFailed = 0;
  const drapePendingSamples = [];
  const drapeRefreshingSamples = [];
  const drapeFailedSamples = [];
  for (const [key, tile] of s1mActiveTiles.entries()) {
    const found = s1mCachedForDesired(key, tile);
    if (found.exact) {
      exactCached += 1;
    } else if (found.cache) {
      fallbackCached += 1;
      staleLod.push({ desired: key, cached: found.cacheKey });
    } else {
      missing += 1;
      notFilled.push({
        key,
        dataset: tile.dataset,
        size: tile.size,
        pending: s1mTerrainPending.has(key),
        failure: s1mTerrainFailures.get(key)?.message || null,
      });
    }
    if (found.cache?.subtiles) {
      for (const sub of found.cache.subtiles.values()) {
        drapeTotal += 1;
        if (sub.drapeImage) {
          drapeTextured += 1;
          if (sub.drapePending && sub.drapePending !== sub.drapeKey) {
            drapeRefreshing += 1;
            if (drapeRefreshingSamples.length < 12) {
              drapeRefreshingSamples.push(
                `${tile.dataset}@sub${sub.N}:${sub.ix},${sub.iy}`,
              );
            }
          }
        } else if (sub.drapePending) {
          drapePending += 1;
          if (drapePendingSamples.length < 12) {
            drapePendingSamples.push(
              `${tile.dataset}@sub${sub.N}:${sub.ix},${sub.iy}`,
            );
          }
        } else if (sub.drapeError) {
          drapeFailed += 1;
          if (drapeFailedSamples.length < 12) {
            drapeFailedSamples.push({
              key: `${tile.dataset}@sub${sub.N}:${sub.ix},${sub.iy}`,
              error: sub.drapeError,
            });
          }
        }
      }
    }
  }
  const sourceStats = s1mDrapeSourceCacheStats();
  return {
    active: s1mActive,
    refreshSeq: s1mRefreshSeq,
    refreshAgeMs: s1mFillMetrics.refreshStartedAt
      ? +(now - s1mFillMetrics.refreshStartedAt).toFixed(0)
      : null,
    desired: s1mActiveTiles.size,
    terrain: {
      exactCached,
      fallbackCached,
      missing,
      pending: s1mTerrainPending.size,
      failures: s1mTerrainFailures.size,
      started: s1mFillMetrics.terrainStarted,
      completed: s1mFillMetrics.terrainCompleted,
      failed: s1mFillMetrics.terrainFailed,
      stale: s1mFillMetrics.terrainStale,
    },
    drape: {
      sourcePending: !!s1mDrapeSourcePending || sourceStats.pending > 0,
      sourceError: s1mDrapeSourceError,
      sources: sourceStats.sources || s1mDrapeSources.length,
      sourceQueries: s1mDrapeSourceCache.size,
      sourceQueriesReady: sourceStats.ready,
      sourceQueriesPending: sourceStats.pending,
      sourceQueriesFailed: sourceStats.failed,
      subtiles: drapeTotal,
      textured: drapeTextured,
      pending: drapePending,
      refreshing: drapeRefreshing,
      failed: drapeFailed,
    },
    paint: s1mFillMetrics.lastPaint,
    notFilled: notFilled.slice(0, 30),
    staleLod: staleLod.slice(0, 30),
    drapePending: drapePendingSamples,
    drapeRefreshing: drapeRefreshingSamples,
    drapeFailed: drapeFailedSamples,
  };
}

function updateImageryLayers() {
  if (!deckOverlay || !MosaicLayerClass || !COGLayerClass) {
    return;
  }

  const layers = [];
  const activeSearchFeatures = lastSearchFeatures || [];

  // 1. Show standard COG Layer
  if (toggleCogEl.checked && activeSearchFeatures.length > 0) {
    // Use memoized array so MosaicLayer sees a stable reference when
    // the underlying features haven't changed (avoids spurious
    // tile-layer resets on pan-only updateImageryLayers calls).
    const imagerySources = getImagerySources();
    if (imagerySources.length > 0) {
      layers.push(
        new MosaicLayerClass({
          id: "naip-imagery",
          sources: imagerySources,
          revision: imageryRevision,
          // Keep the default per-origin concurrency limiter (6 requests).
          // It's what queues the COG range fetches so MosaicLayer's
          // getPriority (distance to viewport center) can pull central
          // tiles ahead of edge tiles -- i.e. fill from the middle out.
          // An unbounded limit (the old maxRequests: 9999) fired every
          // fetch at once, so they painted in random network-completion
          // order. forwarded below via resolveGeotiffSource.
          // Keep all rendered COGs cached so panning back is instant and
          // new searches only trigger rendering for new sources. Sized at
          // 2x the default search limit: comfortable headroom so a typical
          // result set (plus a pan or an overlapping re-search) never evicts
          // an on-screen tile. A custom limit above this (up to the server's
          // 10000 cap) can still exceed it and evict the least-recently-used,
          // off-center tiles -- intentional, so memory stays bounded.
          maxCacheSize: SEARCH_LIMIT_DEFAULT * 2,
          getSource: (source, opts) => resolveGeotiffSource(source, opts),
          onSourceError: (source, { error }) => {
            if (isAbortLikeError(error)) {
              return;
            }
            // A lazily-signed URL can lapse if a tile sits cached past its
            // expiry and deck.gl issues a fresh Range request. Evict the
            // stale signature + decoded source and re-resolve once so the
            // next pass re-signs; the guard set avoids a retry loop.
            const s3href = source?.assets?.image?.href;
            if (
              s3href &&
              isExpiredSignatureError(error) &&
              !resignAttempted.has(s3href)
            ) {
              resignAttempted.add(s3href);
              signedUrlCache.delete(s3href);
              deleteGeotiffSourceCacheEntry(s3href);
              imageryRevision += 1;
              updateImageryLayers();
              return;
            }
            console.error("Imagery source error", source?.id, error);
            imageryStatusEl.textContent = `Imagery source error for ${source?.id ?? "unknown"}: ${error?.message ?? error}`;
            imageryStatusEl.className = "small status-warn";
          },
          renderSource: (source, { data, signal }) => {
            if (!source) {
              return null;
            }
            return buildCogSourceLayer({
              source,
              data,
              signal,
              id: `cog-${source.id}`,
              extent: undefined,
              revision: imageryRevision,
            });
          },
        }),
      );
    }
  }

  for (const l of s1mLayers) {
    layers.push(l);
  }

  if (
    toggleS1MFootprintsLayerEl?.checked &&
    s1mFootprintsVisibleAtCurrentZoom() &&
    s1mFootprintTiles.length > 0 &&
    PathLayerClass
  ) {
    const paths = s1mFootprintTiles.flatMap((tile) => s1mFootprintPaths(tile));
    if (paths.length > 0) {
      layers.push(
        new PathLayerClass({
          id: "s1m-footprints-layer",
          data: paths,
          getPath: (path) => path,
          getColor: [14, 165, 233, 120],
          getWidth: 2,
          widthMinPixels: 1,
          parameters: {
            depthWriteEnabled: false,
            depthCompare: "always",
          },
          pickable: false,
        }),
      );
    }
  }

  if (toggleNaipCoverageMvtLayerEl?.checked && MVTLayerClass) {
    layers.push(
      new MVTLayerClass({
        id: "naip-coverage-mvt-deck",
        data: naipCoverageMvtUrl(),
        minZoom: NAIP_COVERAGE_MVT_MIN_Z,
        maxZoom: NAIP_COVERAGE_MVT_MAX_SOURCE_Z,
        maxCacheSize: 64,
        filled: true,
        stroked: true,
        getFillColor: [...NAIP_COVERAGE_FOOTPRINT_RGBA, 0],
        getLineColor: [...NAIP_COVERAGE_FOOTPRINT_RGBA, 128],
        getLineWidth: 1,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1,
        pickable: false,
        parameters: {
          depthWriteEnabled: false,
          depthCompare: "always",
        },
      }),
    );
  }

  deckOverlay.setProps({ layers });
}

// --- S1M terrain meshing (option C: CPU grid -> SimpleMeshLayer) ---------
function s1mB64ToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// --- Client-side S1M terrain read (replaces POST /s1m/terrain) ----------
// The S1M DEMs are public LZW float32 COGs on prd-tnm with overviews, so
// the browser reads a downsampled elevation grid directly -- no signing,
// no server round-trip, parallel + cached like the NAIP path. Ports
// read_terrain() from app/api/s1m.py: pick the overview nearest above the
// target size, resample to size x size, and return the same payload shape
// the pipeline already consumes (the decoded Float32 grid as `elev`).
const S1M_EPSG = 6350; // NAD83(2011) CONUS Albers
const S1M_CLIENT_NODATA = -999999.0;
const s1mGeotiffCache = new Map(); // s3 href -> Promise<geotiff>
const s1mGeotiffResolved = new Map(); // s3 href -> resolved geotiff
let _s1mAlbersToWgs = null;

function deleteS1MGeotiffCacheEntry(href) {
  s1mGeotiffCache.delete(href);
  s1mGeotiffResolved.delete(href);
}

function s1mCogHttpUrl(href) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(href);
  return m ? `https://${m[1]}.s3.amazonaws.com/${m[2]}` : href;
}

function resolveS1MGeotiff(href) {
  let pending = s1mGeotiffCache.get(href);
  if (!pending) {
    pending = window.GeoTIFFCoreClass.fromUrl(s1mCogHttpUrl(href), {
      concurrencyLimiter: s1mDrapeConcurrencyLimiter,
      // Cache overview tile-data reads in Cache Storage so they survive
      // reloads/revisits (header/IFD reads keep their own small path).
      // 256 KiB chunks: big enough to coalesce the file-contiguous
      // overview tiles, small enough to avoid the cold over-fetch a
      // 1 MiB chunk causes for S1M's small overview tiles.
      chunkCache: {
        cacheKey: href,
        chunkSize: 256 * 1024,
        cacheName: "s1m-dem-cog-chunks-v1",
        memoryMaxBytes: 16 * 1024 * 1024,
      },
    })
      .then((geotiff) => {
        if (s1mGeotiffCache.get(href) === pending) {
          s1mGeotiffResolved.set(href, geotiff);
        }
        return geotiff;
      })
      .catch((error) => {
        deleteS1MGeotiffCacheEntry(href);
        throw error;
      });
    s1mGeotiffCache.set(href, pending);
  }
  return pending;
}

async function s1mAlbersToWgs() {
  if (!_s1mAlbersToWgs) {
    const def = await epsgResolver(S1M_EPSG);
    const conv = proj4(def, "EPSG:4326");
    _s1mAlbersToWgs = (x, y) => conv.forward([x, y]); // Albers -> [lon, lat]
  }
  return _s1mAlbersToWgs;
}

// Local ellipsoidal ground distance (GRS80) between two nearby lon/lat
// points; over ~1 km it matches a full geodesic to <1 mm. Mirrors the
// pyproj Geod.inv the server uses to turn an Albers metre step into true
// ground metres so adjacent tiles abut.
function s1mGroundDist(lon1, lat1, lon2, lat2) {
  const a = 6378137.0,
    f = 1 / 298.257222101,
    e2 = f * (2 - f);
  const phi = (lat1 * Math.PI) / 180;
  const s = Math.sin(phi),
    denom = 1 - e2 * s * s;
  const M = (a * (1 - e2)) / denom ** 1.5;
  const N = a / Math.sqrt(denom);
  const dN = (((lat2 - lat1) * Math.PI) / 180) * M;
  const dE = (((lon2 - lon1) * Math.PI) / 180) * N * Math.cos(phi);
  return Math.hypot(dN, dE);
}

// Read one COG overview fully into a row-major NW-origin Float32 grid.
async function s1mReadLevelFull(level) {
  const W = level.width,
    H = level.height;
  const out = new Float32Array(W * H);
  const tw = level.tileWidth,
    th = level.tileHeight;
  const tasks = [];
  for (let ty = 0; ty < level.tileCount.y; ty++) {
    for (let tx = 0; tx < level.tileCount.x; tx++) {
      tasks.push(
        level.fetchTile(tx, ty, { boundless: false }).then((td) => {
          const arr = td.array;
          const band = arr.bands ? arr.bands[0] : arr.data;
          const sw = arr.width,
            sh = arr.height;
          const ox = tx * tw,
            oy = ty * th;
          for (let r = 0; r < sh; r++) {
            const gy = oy + r;
            if (gy >= H) {
              break;
            }
            const srow = r * sw,
              drow = gy * W + ox;
            for (let c = 0; c < sw; c++) {
              if (ox + c >= W) {
                break;
              }
              out[drow + c] = band[srow + c];
            }
          }
        }),
      );
    }
  }
  await Promise.all(tasks);
  return { data: out, width: W, height: H };
}

// Bilinear resample src (sw x sh) -> dw x dh; `nd`/large-negative cells are
// voids (partly-void neighbourhoods use the mean of valid corners, fully
// void cells stay nodata) so terrain edges near water don't smear.
function s1mResampleGrid(src, sw, sh, dw, dh, nd) {
  const out = new Float32Array(dw * dh);
  const ok = (v) => v > -9000 && Number.isFinite(v) && v !== nd;
  for (let y = 0; y < dh; y++) {
    const fy = dh > 1 ? (y * (sh - 1)) / (dh - 1) : 0;
    const y0 = Math.floor(fy),
      y1 = Math.min(sh - 1, y0 + 1),
      wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = dw > 1 ? (x * (sw - 1)) / (dw - 1) : 0;
      const x0 = Math.floor(fx),
        x1 = Math.min(sw - 1, x0 + 1),
        wx = fx - x0;
      const v00 = src[y0 * sw + x0],
        v01 = src[y0 * sw + x1];
      const v10 = src[y1 * sw + x0],
        v11 = src[y1 * sw + x1];
      if (ok(v00) && ok(v01) && ok(v10) && ok(v11)) {
        const top = v00 * (1 - wx) + v01 * wx;
        const bot = v10 * (1 - wx) + v11 * wx;
        out[y * dw + x] = top * (1 - wy) + bot * wy;
      } else {
        let sum = 0,
          n = 0;
        if (ok(v00)) {
          sum += v00;
          n++;
        }
        if (ok(v01)) {
          sum += v01;
          n++;
        }
        if (ok(v10)) {
          sum += v10;
          n++;
        }
        if (ok(v11)) {
          sum += v11;
          n++;
        }
        out[y * dw + x] = n ? sum / n : nd;
      }
    }
  }
  return out;
}

// Read a downsampled size x size elevation grid for a whole S1M DEM tile,
// returning the same payload the old POST /s1m/terrain produced.
async function readS1MTerrainClient(href, size) {
  size = Math.max(16, Math.min(Number(size) || 256, 512));
  const g = await resolveS1MGeotiff(href);
  const levels = [g, ...(g.overviews || [])];
  // Smallest overview at least `size` wide, so we downsample (never upsample).
  const sorted = levels.slice().sort((a, b) => a.width - b.width);
  let level = sorted[sorted.length - 1];
  for (const lv of sorted) {
    if (lv.width >= size) {
      level = lv;
      break;
    }
  }

  const { data: raw, width: rw, height: rh } = await s1mReadLevelFull(level);
  const ndRaw = g.cachedTags?.nodata;
  const srcNd =
    ndRaw != null && ndRaw !== "" ? Number(ndRaw) : S1M_CLIENT_NODATA;
  const grid = s1mResampleGrid(raw, rw, rh, size, size, srcNd);

  // Full-tile Albers extent + centre from the base level's transform.
  const [ax0, ay0] = affine.apply(g.transform, 0, 0);
  const [ax1, ay1] = affine.apply(g.transform, g.width, g.height);
  const extEast = Math.abs(ax1 - ax0),
    extNorth = Math.abs(ay1 - ay0);
  const cxA = (ax0 + ax1) / 2,
    cyA = (ay0 + ay1) / 2;

  const to4326 = await s1mAlbersToWgs();
  const [clon, clat] = to4326(cxA, cyA);
  const [lonE, latE] = to4326(cxA + 1000, cyA);
  const [lonN, latN] = to4326(cxA, cyA + 1000);
  const scaleEast = s1mGroundDist(clon, clat, lonE, latE) / 1000;
  const scaleNorth = s1mGroundDist(clon, clat, lonN, latN) / 1000;
  const dxA = extEast / Math.max(size - 1, 1);
  const dyA = extNorth / Math.max(size - 1, 1);

  // Normalise voids to the viewer sentinel and collect the valid range.
  let zmin = Infinity,
    zmax = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v > -9000 && Number.isFinite(v) && v !== srcNd) {
      if (v < zmin) {
        zmin = v;
      }
      if (v > zmax) {
        zmax = v;
      }
    } else {
      grid[i] = S1M_CLIENT_NODATA;
    }
  }
  if (!Number.isFinite(zmin)) {
    zmin = 0;
    zmax = 0;
  }

  return {
    width: size,
    height: size,
    step: [dxA * scaleEast, dyA * scaleNorth], // true ground metres/cell (east, north)
    center_lnglat: [clon, clat],
    nodata: S1M_CLIENT_NODATA,
    z_range: [zmin, zmax],
    epsg: S1M_EPSG,
    dataset: href,
    elev: grid,
  };
}

// Simple hypsometric ramp (low=green -> mid=tan -> high=white), t in [0,1].
function s1mHypso(t) {
  const stops = [
    [0.0, [60, 120, 60]],
    [0.4, [120, 150, 80]],
    [0.7, [170, 140, 100]],
    [0.9, [190, 175, 160]],
    [1.0, [245, 245, 245]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1],
        [t1, c1] = stops[i];
      const f = (t - t0) / Math.max(1e-6, t1 - t0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + f * (c1[k] - c0[k])));
    }
  }
  return stops[stops.length - 1][1];
}

// Build a SimpleMeshLayer terrain mesh from the /s1m/terrain payload.
// Positions are ENU metres relative to the tile centre (METER_OFFSETS):
// x east, y north, z = (elevation - tileMin) * exaggeration. Nodata voids
// are dropped (alpha 0) and any triangle touching one is skipped.
function buildS1MTerrainLayer(data, exag, wireframe, range) {
  const W = data.width,
    H = data.height;
  const [sx, sy] = data.step; // metres per cell (east, north)
  const elev = data.elev || s1mB64ToFloat32(data.elev_b64);
  const nd = data.nodata;
  const [zmin, zmax] = range || data.z_range; // shared view range, not per-tile
  const zspan = Math.max(1e-6, zmax - zmin);
  const N = W * H;
  const positions = new Float32Array(N * 3);
  const colors = new Uint8Array(N * 4);
  // Rotate the Albers grid offsets into true ENU so tiles abut (see
  // s1mConvergenceRad / the GPU mesh builder).
  const gconv = s1mConvergenceRad(data.center_lnglat[0]);
  const cosG = Math.cos(gconv),
    sinG = Math.sin(gconv);

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const raw = elev[i];
      const isVoid = raw === nd || !Number.isFinite(raw);
      const z = isVoid ? zmin : raw;
      const ex = (c - (W - 1) / 2) * sx;
      const ny = ((H - 1) / 2 - r) * sy;
      positions[i * 3] = ex * cosG + ny * sinG;
      positions[i * 3 + 1] = -ex * sinG + ny * cosG;
      positions[i * 3 + 2] = (z - zmin) * exag;
      const t = isVoid ? 0 : (z - zmin) / zspan;
      const [cr, cg, cb] = s1mHypso(t);
      colors[i * 4] = cr;
      colors[i * 4 + 1] = cg;
      colors[i * 4 + 2] = cb;
      colors[i * 4 + 3] = isVoid ? 0 : 255;
    }
  }

  // Per-vertex normals from finite differences of the exaggerated surface.
  const normals = new Float32Array(N * 3);
  const zAt = (r, c) => positions[(r * W + c) * 3 + 2];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const l = zAt(r, Math.max(0, c - 1)),
        rt = zAt(r, Math.min(W - 1, c + 1));
      const up = zAt(Math.max(0, r - 1), c),
        dn = zAt(Math.min(H - 1, r + 1), c);
      const nx = -(rt - l) / (2 * sx);
      const ny = (up - dn) / (2 * sy); // up == smaller r == more north
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (r * W + c) * 3;
      normals[i] = nx * inv;
      normals[i + 1] = ny * inv;
      normals[i + 2] = nz * inv;
    }
  }

  const ok = (i) => colors[i * 4 + 3] !== 0;
  const idx = [];
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const a = r * W + c,
        b = r * W + c + 1,
        d = (r + 1) * W + c,
        e = (r + 1) * W + c + 1;
      if (ok(a) && ok(d) && ok(b)) {
        idx.push(a, d, b);
      }
      if (ok(b) && ok(d) && ok(e)) {
        idx.push(b, d, e);
      }
    }
  }

  const [clon, clat] = data.center_lnglat;
  return new SimpleMeshLayerClass({
    id: `s1m-terrain-${data.dataset}`,
    data: [{ position: [0, 0, 0] }],
    coordinateSystem: S1M_COORD.METER_OFFSETS,
    coordinateOrigin: [clon, clat, 0],
    getPosition: (d) => d.position,
    getColor: [255, 255, 255],
    _useMeshColors: true,
    mesh: {
      attributes: {
        POSITION: { value: positions, size: 3 },
        NORMAL: { value: normals, size: 3 },
        COLOR_0: { value: colors, size: 4, normalized: true },
      },
      indices: { value: new Uint32Array(idx), size: 1 },
    },
    material: {
      ambient: 0.5,
      diffuse: 0.6,
      shininess: 16,
      specularColor: [40, 40, 40],
    },
    wireframe: !!wireframe,
    parameters: { cullMode: "none" },
    pickable: false,
  });
}

// --- Option B: GPU vertex displacement (package TerrainMeshLayer) --------
// Flat draped grid (POSITION z=0 + TEXCOORD_0) plus a zero fp64 low part;
// the elevation is uploaded once as an r32float texture and the vertex
// shader displaces z (see deck.gl-raster TerrainDisplace). Reused across
// exaggeration changes, which are a free uniform update (no re-mesh).
// Albers (EPSG:6350) grid convergence at a longitude: the angle between the
// tile's grid axes and true ENU. n = (sin29.5 + sin45.5)/2 is the Albers
// cone constant; central meridian is -96. S1M tile centres march along the
// Albers grid, so each mesh must be rotated by this angle (about its centre)
// or north-up squares on a rotated grid leave a lattice of gaps.
function s1mConvergenceRad(lon) {
  return ((lon + 96) * 0.602835 * Math.PI) / 180;
}

function s1mGpuMesh(W, H, sx, sy, lon) {
  const N = W * H;
  const positions = new Float32Array(N * 3); // z stays 0; displaced on GPU
  const texCoords = new Float32Array(N * 2);
  const g = s1mConvergenceRad(lon),
    cg = Math.cos(g),
    sg = Math.sin(g);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const ex = (c - (W - 1) / 2) * sx; // Albers easting offset
      const ny = ((H - 1) / 2 - r) * sy; // Albers northing offset
      positions[i * 3] = ex * cg + ny * sg; // -> true ENU east
      positions[i * 3 + 1] = -ex * sg + ny * cg; // -> true ENU north
      texCoords[i * 2] = W > 1 ? c / (W - 1) : 0;
      texCoords[i * 2 + 1] = H > 1 ? r / (H - 1) : 0;
    }
  }
  const idx = [];
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const a = r * W + c,
        b = a + 1,
        d = a + W,
        e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  return {
    mesh: {
      indices: { value: new Uint32Array(idx), size: 1 },
      attributes: {
        POSITION: { value: positions, size: 3 },
        TEXCOORD_0: { value: texCoords, size: 2 },
      },
    },
    positions64Low: new Float32Array(N * 3), // ENU metres are fp32-exact at tile scale
  };
}

function bboxIntersects(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
  );
}

function bboxIntersectionArea(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return 0;
  }
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return w * h;
}

function bboxArea(bbox) {
  if (!Array.isArray(bbox)) {
    return 0;
  }
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function bboxOverlapFraction(a, b) {
  const area = bboxArea(a);
  return area ? bboxIntersectionArea(a, b) / area : 0;
}

function bboxCombinedOverlapFraction(target, candidates) {
  const area = bboxArea(target);
  if (!area) {
    return 0;
  }
  let covered = 0;
  for (const candidate of candidates) {
    covered += bboxIntersectionArea(target, candidate);
  }
  return Math.min(1, covered / area);
}

function drapeSourcesForTile(tile, sources = getTerrainDrapeSources()) {
  const bbox = tile?.bbox;
  if (!Array.isArray(bbox)) {
    return [];
  }
  return sources
    .filter((source) => bboxIntersects(source.bbox, bbox))
    .sort(
      (a, b) =>
        bboxIntersectionArea(b.bbox, bbox) - bboxIntersectionArea(a.bbox, bbox),
    );
}

function imagerySourceYear(source) {
  const props = source?.properties || {};
  const value =
    props["naip:year"] ?? props.year ?? props.datetime ?? props.date;
  if (typeof value === "number") {
    return value;
  }
  const match = String(value || "").match(/\b(20\d{2}|19\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function imagerySourceRegion(source) {
  const props = source?.properties || {};
  return String(
    props.region || props.state || props["naip:state"] || "default",
  ).toLowerCase();
}

function mostRecentImagerySources(sources) {
  const latestByRegion = new Map();
  for (const source of sources) {
    const year = imagerySourceYear(source);
    if (!Number.isFinite(year)) {
      continue;
    }
    const region = imagerySourceRegion(source);
    latestByRegion.set(
      region,
      Math.max(latestByRegion.get(region) ?? -Infinity, year),
    );
  }
  if (!latestByRegion.size) {
    return sources;
  }
  return sources.filter((source) => {
    const year = imagerySourceYear(source);
    if (!Number.isFinite(year)) {
      return true;
    }
    return year === latestByRegion.get(imagerySourceRegion(source));
  });
}

function s1mDrapeSearchBody(bbox) {
  const limit = Math.min(
    10000,
    Math.max(5000, Number(limitEl.value || SEARCH_LIMIT_DEFAULT)),
  );
  const body = { collections: [activeCollection()], bbox, limit };
  if (stateEl.value) {
    body.region = stateEl.value;
  } else {
    // Scope to the collection's region ONLY when that region_code names a
    // single lake partition. NAIP's region_code is the multi-state sentinel
    // "CONUS" -- the lake partitions by state (region=ks, mn, ...), so the
    // server lowercases "CONUS"->"conus" and globs region=conus/** which
    // matches nothing (0 sources -> no drape). For CONUS, send no region and
    // let the bbox select across state partitions, mirroring the main search.
    const col = collectionById[activeCollection()];
    if (col?.region_code && col.region_code.toUpperCase() !== "CONUS") {
      body.region = col.region_code;
    }
  }
  if (yearEl.value) {
    body.year = Number(yearEl.value);
  }
  return body;
}

function s1mDrapeSearchKey(body) {
  return JSON.stringify({
    ...body,
    bbox: body.bbox.map((value) => Number(value.toFixed(5))),
  });
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function ensureBuildingFootprintLayers() {
  if (!map.isStyleLoaded?.()) {
    map.once("idle", ensureBuildingFootprintLayers);
    return;
  }
  if (!map.getSource("overture-buildings")) {
    map.addSource("overture-buildings", {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
    // Extruded 3D buildings. base_z / top_z are baked per feature by
    // applyBuildingExtrusionZ: the footprint is sampled against the loaded
    // S1M elevation grids and lifted to sit on the displayed (exaggerated)
    // terrain surface, so bases follow the ground instead of sea level.
    // Colour is driven by the building's own height (top_z - base_z), which
    // is terrain-offset independent.
    map.addLayer({
      id: "overture-buildings-fill",
      type: "fill-extrusion",
      source: "overture-buildings",
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["-", ["get", "top_z"], ["get", "base_z"]],
          0,
          "#0e7490",
          15,
          "#22d3ee",
          60,
          "#a5f3fc",
        ],
        "fill-extrusion-height": ["get", "top_z"],
        "fill-extrusion-base": ["get", "base_z"],
        "fill-extrusion-opacity": 0.85,
        "fill-extrusion-vertical-gradient": true,
      },
    });
    // No separate outline layer: MapLibre line layers drape flat at z=0 and
    // would detach from the extrusions once they are lifted onto the terrain.
    moveMapLibreVectorLayersToTop();
  }
}

function setBuildingFootprints(fc) {
  ensureBuildingFootprintLayers();
  const source = map.getSource("overture-buildings");
  if (source) {
    source.setData(fc || emptyFeatureCollection());
  }
  moveMapLibreVectorLayersToTop();
}

function clearBuildingFootprints() {
  buildingFootprintKey = "";
  buildingFeatureData = null;
  setBuildingFootprints(emptyFeatureCollection());
  if (terBuildingsStatusEl) {
    terBuildingsStatusEl.textContent =
      "— Overture, footprints in the current view";
  }
}

function buildingBboxKey(bboxes) {
  return JSON.stringify(
    bboxes.map((bbox) => bbox.map((value) => Number(value.toFixed(5)))),
  );
}

// Bilinearly sample the loaded S1M elevation grids at a lon/lat, returning
// the ground elevation in metres (NAVD88), or null if no in-view tile covers
// the point. Inverts the same ENU/Albers-convergence placement the terrain
// mesh uses (see buildS1MTerrainLayer) so the sample lands where the tile is
// actually drawn. Decoded elevation arrays are cached per tile entry.
function sampleS1MGroundElevation(lng, lat) {
  for (const c of s1mTileCache.values()) {
    const d = c.data;
    if (!d) {
      continue;
    }
    const [clon, clat] = d.center_lnglat;
    const W = d.width,
      H = d.height;
    const [sx, sy] = d.step;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((clat * Math.PI) / 180);
    const east = (lng - clon) * mPerDegLon;
    const north = (lat - clat) * mPerDegLat;
    const g = s1mConvergenceRad(clon);
    const cosG = Math.cos(g),
      sinG = Math.sin(g);
    // Invert px = ex*cosG + ny*sinG, py = -ex*sinG + ny*cosG (px=east, py=north).
    const ex = cosG * east - sinG * north;
    const ny = sinG * east + cosG * north;
    const col = ex / sx + (W - 1) / 2;
    const row = (H - 1) / 2 - ny / sy;
    if (col < 0 || col > W - 1 || row < 0 || row > H - 1) {
      continue;
    }
    if (!c._elev) {
      c._elev = c.elevations || s1mB64ToFloat32(d.elev_b64);
    }
    const elev = c._elev,
      nd = d.nodata;
    const c0 = Math.floor(col),
      r0 = Math.floor(row);
    const c1 = Math.min(W - 1, c0 + 1),
      r1 = Math.min(H - 1, r0 + 1);
    const fc2 = col - c0,
      fr = row - r0;
    const val = (rr, cc) => {
      const z = elev[rr * W + cc];
      return z === nd || !Number.isFinite(z) ? null : z;
    };
    const v00 = val(r0, c0),
      v01 = val(r0, c1),
      v10 = val(r1, c0),
      v11 = val(r1, c1);
    const present = [v00, v01, v10, v11].filter((z) => z !== null);
    if (!present.length) {
      continue;
    }
    if (v00 === null || v01 === null || v10 === null || v11 === null) {
      return present.reduce((a, b) => a + b, 0) / present.length; // partial void: nearest-ish
    }
    const top = v00 * (1 - fc2) + v01 * fc2;
    const bot = v10 * (1 - fc2) + v11 * fc2;
    return top * (1 - fr) + bot * fr;
  }
  return null;
}

// Bake fill-extrusion base_z / top_z onto each cached footprint. Ground is
// sampled per building and mapped into the terrain's displayed altitude --
// (ground - zmin) * exag, matching the mesh baseline -- then the real
// building height/min_height ride on top so buildings sit on the relief.
// Returns how many footprints were seated on sampled terrain.
function applyBuildingExtrusionZ() {
  if (!buildingFeatureData) {
    return 0;
  }
  const exag = Number(document.getElementById("ter-exag")?.value) || 1;
  const zmin = s1mColorRange()[0];
  const haveTerrain = s1mTileCache.size > 0;
  let seated = 0;
  const features = (buildingFeatureData.features || []).map((f) => {
    const p = f.properties || {};
    const rawH = Number(p.height);
    const height = Number.isFinite(rawH)
      ? rawH
      : Number(p.num_floors)
        ? Number(p.num_floors) * 3.2
        : 4;
    const minH = Number(p.min_height) || 0;
    let ground = 0;
    if (haveTerrain && Array.isArray(f.bbox) && f.bbox.length === 4) {
      const e = sampleS1MGroundElevation(
        (f.bbox[0] + f.bbox[2]) / 2,
        (f.bbox[1] + f.bbox[3]) / 2,
      );
      if (e !== null) {
        ground = (e - zmin) * exag;
        seated++;
      }
    }
    return {
      ...f,
      properties: { ...p, base_z: ground + minH, top_z: ground + height },
    };
  });
  setBuildingFootprints({ type: "FeatureCollection", features });
  return seated;
}

async function refreshBuildingFootprints() {
  if (!terBuildingsEl?.checked) {
    clearBuildingFootprints();
    return;
  }
  if (!s1mActive) {
    buildingFeatureData = null;
    buildingFootprintKey = "";
    setBuildingFootprints(emptyFeatureCollection());
    if (terBuildingsStatusEl) {
      terBuildingsStatusEl.textContent = "— enable terrain first";
    }
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const key = buildingBboxKey([bbox]);
  if (key === buildingFootprintKey) {
    return;
  }
  buildingFootprintKey = key;
  const seq = ++buildingFootprintSeq;
  if (terBuildingsStatusEl) {
    terBuildingsStatusEl.textContent = "— loading footprints in view...";
  }
  try {
    const response = await apiFetch("/buildings/overture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bboxes: [bbox], limit: BUILDING_MAX_FEATURES }),
    });
    if (!response.ok) {
      let detail = `${response.status}`;
      try {
        detail += ` ${await response.text()}`;
      } catch (_) {
        /* ignore */
      }
      throw new Error(detail);
    }
    const fc = await response.json();
    if (seq !== buildingFootprintSeq) {
      return;
    }
    buildingFeatureData = fc;
    const seated = applyBuildingExtrusionZ();
    const count = (fc.features || []).length;
    if (terBuildingsStatusEl) {
      const capped = count >= BUILDING_MAX_FEATURES ? "+" : "";
      terBuildingsStatusEl.textContent = `— ${count.toLocaleString()}${capped} in view${seated ? `, ${seated.toLocaleString()} on terrain` : ""}`;
    }
  } catch (error) {
    if (seq !== buildingFootprintSeq) {
      return;
    }
    buildingFeatureData = null;
    setBuildingFootprints(emptyFeatureCollection());
    if (terBuildingsStatusEl) {
      terBuildingsStatusEl.textContent = `— failed: ${error?.message || error}`;
    }
    console.error("Building footprints failed:", error);
  }
}

function pruneS1MDrapeSourceCache() {
  while (s1mDrapeSourceCache.size > S1M_DRAPE_SOURCE_CACHE_MAX) {
    let deleteKey = null;
    for (const [key, entry] of s1mDrapeSourceCache.entries()) {
      if (!entry.pending) {
        deleteKey = key;
        break;
      }
    }
    if (!deleteKey) {
      deleteKey = s1mDrapeSourceCache.keys().next().value;
    }
    if (!deleteKey) {
      break;
    }
    s1mDrapeSourceCache.delete(deleteKey);
  }
}

function s1mDrapeSourcesForBbox(bbox, seq, schedulePaint) {
  if (!drapeImageryActive()) {
    return getTerrainDrapeSources();
  }
  if (!Array.isArray(bbox)) {
    return [];
  }
  const body = s1mDrapeSearchBody(bbox);
  const key = s1mDrapeSearchKey(body);
  let entry = s1mDrapeSourceCache.get(key);
  if (entry?.error && !entry.pending && entry.failedSeq !== seq) {
    s1mDrapeSourceCache.delete(key);
    entry = null;
  }
  if (entry?.sources) {
    return entry.sources;
  }
  if (entry?.pending) {
    if (entry.notifySeq !== seq) {
      entry.notifySeq = seq;
      entry.pending.then(() => {
        if (seq === s1mRefreshSeq) {
          schedulePaint?.();
        }
      });
    }
    return null;
  }

  const fallbackSources = drapeSourcesForTile(
    { bbox },
    mostRecentImagerySources(getImagerySources()),
  );
  entry = {
    key,
    bbox,
    sources: null,
    rawCount: 0,
    pending: null,
    error: null,
    failedSeq: null,
  };
  s1mDrapeSourceCache.set(key, entry);
  pruneS1MDrapeSourceCache();
  s1mDrapeSourceKey = key;
  s1mDrapeSources = [];
  s1mDrapeSourceError = null;
  const sourceSearchStartedAt = performance.now();
  entry.pending = apiFetch("/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(async (response) => {
      if (!response.ok) {
        let detail = "";
        try {
          detail = await response.text();
        } catch (_) {
          detail = "";
        }
        throw new Error(
          `terrain drape search failed: ${response.status}${detail ? ` ${detail.slice(0, 180)}` : ""}`,
        );
      }
      const data = await response.json();
      const rawSources = (data.features || []).filter(
        (feature) =>
          feature?.assets?.image?.href && Array.isArray(feature?.bbox),
      );
      const sources = mostRecentImagerySources(rawSources);
      entry.sources = sources;
      entry.rawCount = rawSources.length;
      entry.error = null;
      entry.failedSeq = null;
      s1mDrapeSourceKey = key;
      s1mDrapeSources = sources;
      s1mDrapeSourceError = null;
      s1mDrapeMetrics.sourceSearchMs =
        performance.now() - sourceSearchStartedAt;
      s1mDrapeMetrics.sourceRawCount = rawSources.length;
      s1mDrapeMetrics.sourceCount = sources.length;
      s1mDrapeMetrics.sourceError = null;
      renderS1MDrapeMetrics();
      if (seq === s1mRefreshSeq) {
        schedulePaint?.();
      }
      return sources;
    })
    .catch((error) => {
      const message = error?.message || String(error);
      entry.sources = fallbackSources;
      entry.rawCount = fallbackSources.length;
      entry.error = fallbackSources.length ? null : message;
      entry.failedSeq = entry.error ? seq : null;
      s1mDrapeSourceKey = key;
      s1mDrapeSources = fallbackSources;
      s1mDrapeSourceError = entry.error;
      s1mDrapeMetrics.sourceSearchMs =
        performance.now() - sourceSearchStartedAt;
      s1mDrapeMetrics.sourceError = entry.error;
      s1mDrapeMetrics.sourceRawCount = fallbackSources.length;
      s1mDrapeMetrics.sourceCount = fallbackSources.length;
      renderS1MDrapeMetrics();
      if (seq === s1mRefreshSeq) {
        schedulePaint?.();
      }
      return fallbackSources;
    })
    .finally(() => {
      entry.pending = null;
      pruneS1MDrapeSourceCache();
      renderS1MDrapeMetrics();
    });
  schedulePaint?.();
  return null;
}

function displayDrapeRgbaBytes(array, source, image) {
  const width = array.width;
  const height = array.height;
  const sampleCount = array.count || image.cachedTags?.samplesPerPixel || 3;
  let sourceData;
  if (array.layout === "band-separate") {
    sourceData = array.bands;
  } else {
    sourceData = array.data;
  }

  const readSample = (pixel, band) => {
    if (Array.isArray(sourceData)) {
      return sourceData[band]?.[pixel] ?? 0;
    }
    return sourceData[pixel * sampleCount + band] ?? 0;
  };

  const sourceSampleData = Array.isArray(sourceData)
    ? sourceData[0]
    : sourceData;
  let scaleSample = (value) => value;
  if (
    !(
      sourceSampleData instanceof Uint8Array ||
      sourceSampleData instanceof Uint8ClampedArray
    )
  ) {
    const domain = collectionForHref(source?.assets?.image?.href)?.display
      ?.domain;
    const bitsPerSample = image.cachedTags?.bitsPerSample?.[0] || 8;
    const domainMin = Number(domain?.[0] ?? 0);
    const domainMax = Number(
      domain?.[1] ?? (bitsPerSample === 16 ? 65535 : 255),
    );
    const range = Math.max(1, domainMax - domainMin);
    scaleSample = (value) =>
      Math.round(Math.max(0, Math.min(1, (value - domainMin) / range)) * 255);
  }

  const adjusted = new Uint8ClampedArray(width * height * 4);
  const { brightness, contrast } = getDisplayAdjustments();
  for (let pixel = 0; pixel < width * height; pixel++) {
    const dst = pixel * 4;
    const rawR = scaleSample(readSample(pixel, 0));
    const rawG = scaleSample(readSample(pixel, 1));
    const rawB = scaleSample(readSample(pixel, 2));
    const blackNoData = rawR <= 2 && rawG <= 2 && rawB <= 2;
    const r = Math.round(
      Math.max(
        0,
        Math.min(1, (rawR / 255 - 0.5) * contrast + 0.5 + brightness),
      ) * 255,
    );
    const g = Math.round(
      Math.max(
        0,
        Math.min(1, (rawG / 255 - 0.5) * contrast + 0.5 + brightness),
      ) * 255,
    );
    const b = Math.round(
      Math.max(
        0,
        Math.min(1, (rawB / 255 - 0.5) * contrast + 0.5 + brightness),
      ) * 255,
    );
    const whiteCollar =
      r >= 240 &&
      g >= 240 &&
      b >= 240 &&
      Math.max(r, g, b) - Math.min(r, g, b) <= 12;
    adjusted[dst] = r;
    adjusted[dst + 1] = g;
    adjusted[dst + 2] = b;
    adjusted[dst + 3] = blackNoData || whiteCollar ? 0 : 255;
  }
  return {
    layout: "pixel-interleaved",
    width,
    height,
    count: 4,
    data: adjusted,
  };
}

// Decoded-COG-tile cache shared across drape sub-tiles. Adjacent sub-tiles
// of the same S1M tile pick the same overview level (equal bbox span) and
// overlap on COG tiles at their shared edge, so without this each shared
// (source, level, tx, ty) would be fetched + colour-decoded once per
// sub-tile. Keyed on imageryRevision, which is bumped (and this cache
// cleared) on every imagery/display change, so entries never go stale. The
// decoded tiles are read-only, so sharing one array across sub-tiles is safe.
// Byte-budgeted LRU. A fixed count cap starved the cross-sub-tile sharing
// this cache exists for: a single cold drape touches 100-200 unique COG
// tiles (77 sub-tiles x ~2 sources x ~3 tiles, minus edge sharing), so a
// 24-slot cap evicted tiles before neighbours reused them (200+ evictions
// per fill), turning would-be hits back into ~2s range reads. Cap on bytes
// instead so the whole visible working set fits; a high count acts only as
// a backstop. Tile byte-size is known only after decode, so in-flight
// (pending) entries count as 0 until they resolve -- the cache can hold the
// full in-flight burst, then evicts oldest resolved tiles once over budget.
// 96 MB picked from a controlled size sweep (2D imagery off, chunk cache
// cold per trial, medians). The cold working set for a typical pitched view
// (~6 S1M tiles -> ~77 sub-tiles) is ~171 unique COG tiles; redundant
// network re-fetches from cross-sub-tile eviction fall off as 16 MB 25% ->
// 32 MB 17% -> 64 MB 9% -> 128 MB 0%. Wall time is flat across sizes (fetch
// concurrency hides the redundant reads), so this trades S3 GETs (requester
// -pays) + larger-viewport / warm-revisit headroom against memory: 96 MB
// absorbs ~all of the working set with more allocation headroom than 128 MB.
const S1M_COG_TILE_CACHE_MAX_BYTES = 96 * 1024 * 1024; // ~96 MB decoded RGBA
const S1M_COG_TILE_CACHE_MAX_COUNT = 256; // backstop on entry count
const s1mCogTileCache = new Map(); // key -> Promise<decoded rgba tile>
const s1mCogTileCacheBytes = new Map(); // key -> resolved rgba.data.byteLength
let s1mCogTileCacheByteTotal = 0; // running sum of resolved bytes

function setS1MCogTileCacheBytes(key, bytes) {
  const prev = s1mCogTileCacheBytes.get(key);
  if (prev !== undefined) {
    s1mCogTileCacheByteTotal -= prev;
  }
  s1mCogTileCacheBytes.set(key, bytes);
  s1mCogTileCacheByteTotal += bytes;
}

function deleteS1MCogTileCacheEntry(key) {
  if (!key) {
    return;
  }
  s1mCogTileCache.delete(key);
  const prev = s1mCogTileCacheBytes.get(key);
  if (prev !== undefined) {
    s1mCogTileCacheByteTotal -= prev;
    s1mCogTileCacheBytes.delete(key);
  }
}

function clearS1MCogTileCacheEntries() {
  s1mCogTileCache.clear();
  s1mCogTileCacheBytes.clear();
  s1mCogTileCacheByteTotal = 0;
}

function evictS1MCogTileCache() {
  // Oldest-first (Map preserves insertion order); MRU entries are re-set on
  // hit so they move to the end and survive.
  while (
    s1mCogTileCache.size > 1 &&
    (s1mCogTileCacheByteTotal > S1M_COG_TILE_CACHE_MAX_BYTES ||
      s1mCogTileCache.size > S1M_COG_TILE_CACHE_MAX_COUNT)
  ) {
    const oldest = s1mCogTileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    deleteS1MCogTileCacheEntry(oldest);
    s1mBench.cogEvict += 1;
  }
}

function getDrapeCogTile(source, image, level, tx, ty) {
  const key = `${source.id}@${level.width}x${level.height}@${tx},${ty}@${imageryRevision}`;
  let pending = s1mCogTileCache.get(key);
  if (pending) {
    s1mBench.cogHit += 1;
    s1mCogTileCache.delete(key); // LRU: move to most-recently-used
    s1mCogTileCache.set(key, pending);
    return pending;
  }
  s1mBench.cogMiss += 1;
  pending = (async () => {
    const t0 = performance.now();
    const tileData = await level.fetchTile(tx, ty, { boundless: false });
    const t1 = performance.now();
    const rgba = displayDrapeRgbaBytes(tileData.array, source, image);
    const t2 = performance.now();
    s1mBench.cogFetchMs += t1 - t0;
    s1mBench.cogFetchN += 1;
    s1mBench.decodeMs += t2 - t1;
    s1mBench.decodeN += 1;
    if (s1mCogTileCache.get(key) === pending) {
      setS1MCogTileCacheBytes(key, rgba?.data?.byteLength || 0);
      evictS1MCogTileCache(); // budget now knows this tile's real size
    }
    return rgba;
  })().catch((error) => {
    deleteS1MCogTileCacheEntry(key);
    throw error;
  });
  s1mCogTileCache.set(key, pending);
  evictS1MCogTileCache();
  return pending;
}

async function drapeProjectionForImage(image) {
  let pending = drapeProjectionCache.get(image);
  if (!pending) {
    pending = (async () => {
      const crsInput = image.crs;
      const sourceProjection =
        typeof crsInput === "number"
          ? await epsgResolver(crsInput)
          : "coordinate_system" in crsInput
            ? parseWkt(crsInput)
            : crsInput;
      const converter4326 = proj4(sourceProjection, "EPSG:4326");
      return {
        projectFrom4326: (lng, lat) => converter4326.inverse([lng, lat], false),
      };
    })();
    drapeProjectionCache.set(image, pending);
  }
  return pending;
}

async function drapePixelMapper(image, level) {
  const { projectFrom4326 } = await drapeProjectionForImage(image);
  const invTransform = affine.invert(level.transform);
  return (lng, lat) => {
    const [x, y] = projectFrom4326(lng, lat);
    return affine.apply(invTransform, x, y);
  };
}

function s1mLngLatForUv(data, u, v) {
  const W = data.width;
  const H = data.height;
  const sx = data.step[0];
  const sy = data.step[1];
  const [lon0, lat0] = data.center_lnglat;
  const col = u * (W - 1);
  const row = v * (H - 1);
  const ex = (col - (W - 1) / 2) * sx;
  const ny = ((H - 1) / 2 - row) * sy;
  const g = s1mConvergenceRad(lon0);
  const east = ex * Math.cos(g) + ny * Math.sin(g);
  const north = -ex * Math.sin(g) + ny * Math.cos(g);
  const lat = lat0 + north / 111320;
  const lon = lon0 + east / (111320 * Math.cos((lat0 * Math.PI) / 180));
  return [lon, lat];
}

// Map a sub-tile-local uv (0..1 over the sub-tile) into the full tile's uv
// (uvRect = [u0, v0, u1, v1] in full-tile uv space), then to lon/lat. The
// whole-tile case is uvRect [0,0,1,1].
function s1mLngLatForSubUv(data, uvRect, u, v) {
  const uFull = uvRect[0] + u * (uvRect[2] - uvRect[0]);
  const vFull = uvRect[1] + v * (uvRect[3] - uvRect[1]);
  return s1mLngLatForUv(data, uFull, vFull);
}

function chooseDrapeImageLevel(geotiff, source, tileBbox, textureSize) {
  const levels = [geotiff, ...(geotiff.overviews || [])];
  const sourceBbox = source.bbox;
  const sourceLonSpan = Math.max(1e-9, sourceBbox[2] - sourceBbox[0]);
  const tileLonSpan = Math.max(1e-9, tileBbox[2] - tileBbox[0]);
  const desiredSourceWidth = textureSize * (sourceLonSpan / tileLonSpan);
  return levels.reduce((best, level) => {
    const bestScore = Math.abs(
      Math.log2(Math.max(1, best.width) / desiredSourceWidth),
    );
    const score = Math.abs(
      Math.log2(Math.max(1, level.width) / desiredSourceWidth),
    );
    return score < bestScore ? level : best;
  }, levels[0]);
}

function bilinearCornerMapper(nw, ne, se, sw) {
  return (u, v) => {
    const topCol = nw[0] + (ne[0] - nw[0]) * u;
    const botCol = sw[0] + (se[0] - sw[0]) * u;
    const topRow = nw[1] + (ne[1] - nw[1]) * u;
    const botRow = sw[1] + (se[1] - sw[1]) * u;
    return [topCol + (botCol - topCol) * v, topRow + (botRow - topRow) * v];
  };
}

async function paintDrapeSource(data, region, source, out, drapeSize) {
  const image = await resolveGeotiffSource(source, {
    concurrencyLimiter: s1mDrapeConcurrencyLimiter,
  });
  const level = chooseDrapeImageLevel(image, source, region.bbox, drapeSize);
  const [tw, th] = [level.tileWidth, level.tileHeight];
  const sourceBbox = source.bbox;
  const toPixel = await drapePixelMapper(image, level);
  const toLngLat = (u, v) => s1mLngLatForSubUv(data, region.uvRect, u, v);
  const nw = toLngLat(0, 0);
  const ne = toLngLat(1, 0);
  const se = toLngLat(1, 1);
  const sw = toLngLat(0, 1);
  const sampleCorners = [
    toPixel(nw[0], nw[1]),
    toPixel(ne[0], ne[1]),
    toPixel(se[0], se[1]),
    toPixel(sw[0], sw[1]),
  ];
  const pixelFromUv = bilinearCornerMapper(
    sampleCorners[0],
    sampleCorners[1],
    sampleCorners[2],
    sampleCorners[3],
  );
  const lngLatFromUv = bilinearCornerMapper(nw, ne, se, sw);
  const cols = sampleCorners.map((p) => p[0]);
  const rows = sampleCorners.map((p) => p[1]);
  const c0 = Math.max(0, Math.floor(Math.min(...cols) / tw));
  const c1 = Math.min(
    level.tileCount.x - 1,
    Math.floor(Math.max(...cols) / tw),
  );
  const r0 = Math.max(0, Math.floor(Math.min(...rows) / th));
  const r1 = Math.min(
    level.tileCount.y - 1,
    Math.floor(Math.max(...rows) / th),
  );
  if (c0 > c1 || r0 > r1) {
    return 0;
  }
  // Collect the covering COG tiles into a flat grid addressed by numeric
  // index (tileGridW * (ty-r0) + (tx-c0)) so the per-pixel raster loop below
  // needs no template-string key or Map lookup -- at 384^2 px x many source
  // paints those string allocations were pure GC pressure.
  const tileGridW = c1 - c0 + 1;
  const tileGridH = r1 - r0 + 1;
  const tiles = new Array(tileGridW * tileGridH);
  const tilePromises = [];
  for (let ty = r0; ty <= r1; ty++) {
    for (let tx = c0; tx <= c1; tx++) {
      const gi = (ty - r0) * tileGridW + (tx - c0);
      tilePromises.push(
        getDrapeCogTile(source, image, level, tx, ty).then((rgba) => {
          tiles[gi] = rgba;
        }),
      );
    }
  }
  await Promise.all(tilePromises);
  const rasterStartedAt = performance.now();
  let filled = 0;
  for (let y = 0; y < drapeSize; y++) {
    const v = drapeSize > 1 ? y / (drapeSize - 1) : 0;
    for (let x = 0; x < drapeSize; x++) {
      const u = drapeSize > 1 ? x / (drapeSize - 1) : 0;
      const dst = (y * drapeSize + x) * 4;
      if (out[dst + 3] > 0) {
        continue;
      }
      if (Array.isArray(sourceBbox)) {
        const [lon, lat] = lngLatFromUv(u, v);
        if (
          lon < sourceBbox[0] ||
          lon > sourceBbox[2] ||
          lat < sourceBbox[1] ||
          lat > sourceBbox[3]
        ) {
          continue;
        }
      }
      const [col, row] = pixelFromUv(u, v);
      if (col < 0 || col >= level.width || row < 0 || row >= level.height) {
        continue;
      }
      const tx = Math.floor(col / tw);
      const ty = Math.floor(row / th);
      const src = tiles[(ty - r0) * tileGridW + (tx - c0)];
      if (!src) {
        continue;
      }
      const sx = Math.max(
        0,
        Math.min(src.width - 1, Math.floor(col - tx * tw)),
      );
      const sy = Math.max(
        0,
        Math.min(src.height - 1, Math.floor(row - ty * th)),
      );
      const srcIdx = (sy * src.width + sx) * 4;
      if (src.data[srcIdx + 3] <= 0) {
        continue;
      }
      out[dst] = src.data[srcIdx];
      out[dst + 1] = src.data[srcIdx + 1];
      out[dst + 2] = src.data[srcIdx + 2];
      out[dst + 3] = src.data[srcIdx + 3];
      filled += 1;
    }
  }
  s1mBench.rasterMs += performance.now() - rasterStartedAt;
  s1mBench.rasterN += 1;
  return filled; // count of newly-opaque pixels this source contributed
}

function activeDrapeCacheKeys() {
  const active = new Set();
  for (const cache of s1mTileCache.values()) {
    if (!cache.subtiles) {
      continue;
    }
    for (const sub of cache.subtiles.values()) {
      if (sub.drapeKey) {
        active.add(sub.drapeKey);
      }
      if (sub.drapePending) {
        active.add(sub.drapePending);
      }
    }
  }
  return active;
}

function pruneS1MDrapeCache() {
  if (s1mDrapeCache.size <= S1M_DRAPE_CACHE_MAX) {
    return;
  }
  const active = activeDrapeCacheKeys();
  for (const key of s1mDrapeCache.keys()) {
    if (s1mDrapeCache.size <= S1M_DRAPE_CACHE_MAX) {
      break;
    }
    if (!active.has(key)) {
      deleteS1MDrapeCacheEntry(key);
      s1mBench.drapeEvict += 1;
    }
  }
}

function disposeS1MTileCache(cache) {
  if (!cache) {
    return;
  }
  cache.drapeImage = null;
  cache.layer = null;
  cache.elevations = null;
  cache.gpuMesh = null;
  if (!cache.subtiles) {
    return;
  }
  for (const sub of cache.subtiles.values()) {
    if (sub.drapeKey) {
      deleteS1MDrapeCacheEntry(sub.drapeKey);
    }
    if (sub.drapePending) {
      deleteS1MDrapeCacheEntry(sub.drapePending);
    }
    sub.drapeImage = null;
    sub.drapeKey = null;
    sub.drapePending = null;
    sub.elev = null;
    sub.gpuMesh = null;
  }
  cache.subtiles.clear();
}

function releaseS1MDrapeMemory() {
  clearS1MDrapeCacheEntries();
  s1mDrapedSubdivByDataset.clear(); // drapes are gone -> drop the ratchet so tiles re-drape at the current zoom
  clearS1MCogTileCacheEntries();
  clearGeotiffSourceCache();
  clearS1MDrapeSourceCache();
  drapeProjectionCache = new WeakMap();
  for (const cache of s1mTileCache.values()) {
    if (!cache.subtiles) {
      continue;
    }
    for (const sub of cache.subtiles.values()) {
      sub.drapeImage = null;
      sub.drapeKey = null;
      sub.drapePending = null;
    }
  }
}

async function buildDrapeImage(data, region, sources, drapeSize) {
  const out = new Uint8ClampedArray(drapeSize * drapeSize * 4);
  const totalPixels = drapeSize * drapeSize;
  const cappedSources = sources.slice(0, s1mMaxDrapeSourcesPerTile());
  // paintDrapeSource only writes previously-transparent pixels and returns
  // how many it newly filled, so a running sum tells us when the sub-tile is
  // fully opaque in O(1) -- no need to rescan the whole 384^2 buffer per
  // source (drapeIsFullyOpaque) just to decide whether to stop early.
  let filled = 0;
  for (let i = 0; i < cappedSources.length; i++) {
    const source = cappedSources[i];
    filled +=
      (await paintDrapeSource(data, region, source, out, drapeSize)) || 0;
    if (filled >= totalPixels) {
      break;
    }
    if (
      i + 1 === s1mInitialDrapeSourcesPerTile() &&
      cappedSources.length > i + 1
    ) {
      s1mDrapeMetrics.noDataSourceFallbacks += 1;
    }
  }
  return new ImageData(out, drapeSize, drapeSize);
}

// --- Imagery drape sub-tiling ----------------------------------------------
// A single S1M tile covers ~10 km, so one stretched texture is coarse. In
// GPU + imagery-drape mode each tile is split into an N×N grid of sub-tiles
// (N from projected screen size), each carrying its own 512² NAIP texture
// and a *sliced* elevation sub-grid -- both addressed by the same local
// 0..1 TEXCOORD_0, so TerrainMeshLayer/TerrainDisplace need no changes.
// Only sub-tiles intersecting the viewport are draped, so cost tracks the
// visible area rather than the whole (mostly off-screen) tile.

// Power-of-two subdivision so splits are clean and the cache key is stable.
// Small-COG collections (NJ ~1.5 km COGs vs a ~12 km S1M tile) subdivide
// more aggressively and never drop to subdiv 1: a full-tile sub-tile would
// need 40+ COGs -- past the source cap (undraped/green gaps) and slow to
// build. Finer sub-tiles each need only a handful of COGs, so they cover
// fully and build faster (decoded COG chunks are cached + shared between
// adjacent sub-tiles, so the extra splits are cheap).
function s1mSubdiv(tile) {
  const px = s1mProjectedTilePixels(tile);
  // Discrete ladder targeting a roughly constant sub-tile screen size, now
  // extended past the old cap of 6 so high-zoom views keep sub-dividing
  // (finer COG overview -> sharper imagery) instead of freezing at ~5 m/px.
  // Discrete steps keep the drape cache key (which embeds sub.N) stable across
  // a zoom range. Small-COG collections never drop to subdiv 1 (a full ~12 km
  // tile would need 40+ of their ~1.5 km COGs -> past the source cap). The cap
  // (s1mSubdivMax) is tile-count responsive, so this only goes high when few
  // tiles are in view; the viewport cull keeps the built sub-tile count small.
  let n;
  if (px >= 12000) {
    n = 32;
  } else if (px >= 6000) {
    n = 16;
  } else if (px >= 3000) {
    n = 8;
  } else if (px >= 1500) {
    n = 4;
  } else if (px >= 760) {
    n = 2;
  } else {
    n = isSmallCogCollection() ? 2 : 1;
  }
  return Math.min(n, s1mSubdivMax());
}

// N+1 shared grid-index boundaries across [0..count-1]; adjacent sub-tiles
// share an edge row/col so meshes abut with no crack.
function s1mSubBoundaries(count, n) {
  const b = [];
  for (let i = 0; i <= n; i++) {
    b.push(Math.round((i * (count - 1)) / n));
  }
  return b;
}

// Axis-aligned lon/lat bbox enclosing a sub-grid (the tile is slightly
// rotated by Albers convergence, so take the envelope of the four corners).
function s1mSubTileBbox(data, c0, c1, r0, r1) {
  const W = data.width,
    H = data.height;
  const corners = [
    s1mLngLatForUv(data, c0 / (W - 1), r0 / (H - 1)),
    s1mLngLatForUv(data, c1 / (W - 1), r0 / (H - 1)),
    s1mLngLatForUv(data, c1 / (W - 1), r1 / (H - 1)),
    s1mLngLatForUv(data, c0 / (W - 1), r1 / (H - 1)),
  ];
  const lons = corners.map((p) => p[0]);
  const lats = corners.map((p) => p[1]);
  return [
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats),
  ];
}

// Sliced flat draped sub-mesh: POSITION in tile-centre ENU metres (same
// formula as s1mGpuMesh, so sub-tiles share the tile coordinateOrigin),
// TEXCOORD_0 local 0..1 across the sub-grid.
function s1mGpuSubMesh(data, c0, c1, r0, r1) {
  const W = data.width,
    H = data.height;
  const sx = data.step[0],
    sy = data.step[1];
  const gw = c1 - c0 + 1,
    gh = r1 - r0 + 1;
  const N = gw * gh;
  const positions = new Float32Array(N * 3);
  const texCoords = new Float32Array(N * 2);
  const g = s1mConvergenceRad(data.center_lnglat[0]);
  const cg = Math.cos(g),
    sg = Math.sin(g);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = (r - r0) * gw + (c - c0);
      const ex = (c - (W - 1) / 2) * sx;
      const ny = ((H - 1) / 2 - r) * sy;
      positions[i * 3] = ex * cg + ny * sg;
      positions[i * 3 + 1] = -ex * sg + ny * cg;
      texCoords[i * 2] = gw > 1 ? (c - c0) / (gw - 1) : 0;
      texCoords[i * 2 + 1] = gh > 1 ? (r - r0) / (gh - 1) : 0;
    }
  }
  const idx = [];
  for (let r = 0; r < gh - 1; r++) {
    for (let c = 0; c < gw - 1; c++) {
      const a = r * gw + c,
        b = a + 1,
        d = a + gw,
        e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  return {
    gw,
    gh,
    mesh: {
      indices: { value: new Uint32Array(idx), size: 1 },
      attributes: {
        POSITION: { value: positions, size: 3 },
        TEXCOORD_0: { value: texCoords, size: 2 },
      },
    },
    positions64Low: new Float32Array(N * 3),
  };
}

// Build (once, cached on the tile entry) a sub-tile's geometry: sliced
// elevation sub-array + mesh + bbox + uvRect into the full tile.
function ensureSubTile(cache, ix, iy, n, bx, by) {
  const subKey = `${n}:${ix},${iy}`;
  if (!cache.subtiles) {
    cache.subtiles = new Map();
  }
  let sub = cache.subtiles.get(subKey);
  if (sub) {
    return sub;
  }
  const data = cache.data;
  const W = data.width,
    H = data.height;
  const c0 = bx[ix],
    c1 = bx[ix + 1],
    r0 = by[iy],
    r1 = by[iy + 1];
  const m = s1mGpuSubMesh(data, c0, c1, r0, r1);
  const elev = new Float32Array(m.gw * m.gh);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      elev[(r - r0) * m.gw + (c - c0)] = cache.elevations[r * W + c];
    }
  }
  sub = {
    ix,
    iy,
    N: n,
    c0,
    c1,
    r0,
    r1,
    gpuMesh: m,
    gw: m.gw,
    gh: m.gh,
    elev,
    bbox: s1mSubTileBbox(data, c0, c1, r0, r1),
    uvRect: [c0 / (W - 1), r0 / (H - 1), c1 / (W - 1), r1 / (H - 1)],
    drapeImage: null,
    drapeKey: null,
    drapePending: null,
    data, // Store data reference for fallback building
  };
  cache.subtiles.set(subKey, sub);
  return sub;
}

// Async-build a sub-tile's 512² NAIP texture (shared promise cache + drape
// metrics, like the old whole-tile path). Re-builds when imagery changes
// (revision is in the key).
function ensureSubTileDrape(data, tile, sub, schedulePaint, seq) {
  const region = { bbox: sub.bbox, uvRect: sub.uvRect };
  const sourceBbox = Array.isArray(tile?.bbox) ? tile.bbox : sub.bbox;
  const sourcePool = s1mDrapeSourcesForBbox(sourceBbox, seq, schedulePaint);
  const sourceBody = s1mDrapeSearchBody(sourceBbox);
  const sourceKey = `sources:${s1mDrapeSearchKey(sourceBody)}`;
  if (!sourcePool) {
    sub.drapePending = sourceKey;
    return;
  }
  if (sub.drapePending === sourceKey) {
    sub.drapePending = null;
  }
  const sources = drapeSourcesForTile(region, sourcePool).slice(
    0,
    s1mMaxDrapeSourcesPerTile(),
  );
  if (!sources.length) {
    sub.drapeError = "no imagery sources intersect S1M subtile";
    return;
  }
  sub.drapeError = null;
  const hrefKey = sources.map((s) => s.assets?.image?.href || s.id).join("|");
  const key = `${data.dataset}@sub${sub.N}:${sub.ix},${sub.iy}@${hrefKey}@${imageryRevision}@${S1M_SUBTILE_DRAPE_SIZE}`;
  if (sub.drapeKey === key || sub.drapePending === key) {
    return;
  }
  let pending = s1mDrapeCache.get(key);
  if (!pending) {
    const startedAt = performance.now();
    s1mDrapeMetrics.tilesStarted += 1;
    s1mDrapeMetrics.tileSourceRefs += sources.length;
    s1mDrapeMetrics.analyticRefs += sources.filter((s) =>
      s?.assets?.image?.href?.startsWith("s3://naip-analytic/"),
    ).length;
    s1mDrapeMetrics.lastSourceRefs = sources.length;
    s1mDrapeMetrics.maxSourceRefs = Math.max(
      s1mDrapeMetrics.maxSourceRefs,
      sources.length,
    );
    s1mDrapeMetrics.lastHref = sources[0]?.assets?.image?.href || null;
    renderS1MDrapeMetrics();
    pending = buildDrapeImage(data, region, sources, S1M_SUBTILE_DRAPE_SIZE)
      .then((imageData) => {
        // Record the finest subdivision actually draped for this tile so
        // s1mBuildTileLayers can ratchet -- never re-drape coarser on zoom-out.
        const drapedMax = s1mDrapedSubdivByDataset.get(data.dataset) || 0;
        if (sub.N > drapedMax) {
          s1mDrapedSubdivByDataset.set(data.dataset, sub.N);
        }
        const elapsed = performance.now() - startedAt;
        s1mDrapeMetrics.tilesCompleted += 1;
        s1mDrapeMetrics.totalTileMs += elapsed;
        s1mDrapeMetrics.lastTileMs = elapsed;
        s1mBench.drapeBuildMs += elapsed;
        s1mBench.drapeBuildN += 1;
        if (s1mDrapeCache.get(key) === pending) {
          s1mDrapeCacheBytes.set(key, imageData?.data?.byteLength || 0);
        }
        renderS1MDrapeMetrics();
        return imageData;
      })
      .catch((error) => {
        s1mDrapeCacheBytes.delete(key);
        s1mDrapeMetrics.tilesFailed += 1;
        s1mDrapeMetrics.sourceError = error?.message || String(error);
        s1mDrapeMetrics.lastTileMs = performance.now() - startedAt;
        renderS1MDrapeMetrics();
        throw error;
      });
    s1mDrapeCache.set(key, pending);
    pruneS1MDrapeCache();
  }
  const oldDrapeKey = sub.drapeKey;
  sub.drapePending = key;
  pending
    .then((imageData) => {
      sub.drapeImage = imageData;
      sub.drapeKey = key;
      if (sub.drapePending === key) {
        sub.drapePending = null;
      }
      if (oldDrapeKey && oldDrapeKey !== key) {
        deleteS1MDrapeCacheEntry(oldDrapeKey);
      }
      pruneS1MDrapeCache();
      if (s1mActive && seq === s1mRefreshSeq) {
        schedulePaint?.();
      }
    })
    .catch((error) => {
      if (sub.drapePending === key) {
        sub.drapePending = null;
      }
      sub.drapeError = error?.message || String(error);
      console.error("Drape sub-tile failed:", error);
    });
}

function buildS1MSubTileLayerGPU(data, sub, exag, range) {
  const subData = sub.data || data;
  const [zmin, zmax] = range || subData.z_range;
  const [clon, clat] = subData.center_lnglat;
  return new TerrainMeshLayerClass({
    id: `s1m-terrain-${subData.dataset}-${subData.width}-${sub.N}-${sub.ix}-${sub.iy}`,
    coordinateSystem: S1M_COORD.METER_OFFSETS,
    coordinateOrigin: [clon, clat, 0],
    mesh: sub.gpuMesh.mesh,
    data: {
      length: 1,
      attributes: { positions64Low: sub.gpuMesh.positions64Low },
    },
    elevationData: sub.elev,
    gridWidth: sub.gw,
    gridHeight: sub.gh,
    stepX: subData.step[0],
    stepY: subData.step[1],
    exag,
    zmin,
    zspan: Math.max(1e-6, zmax - zmin),
    nodata: subData.nodata,
    drapeImage: sub.drapeImage || null,
    wireframe: false,
    parameters: { cullMode: "none" },
    pickable: false,
  });
}

// Layers for one S1M tile during a refresh: sub-tiled in GPU+imagery-drape
// mode (viewport-culled, draping triggered for visible sub-tiles), else the
// single whole-tile layer (shaded GPU or CPU wireframe) as before.
function s1mBuildTileLayers(
  cache,
  tile,
  exag,
  range,
  viewBbox,
  schedulePaint,
  seq,
) {
  const gpu =
    !!document.getElementById("ter-gpu")?.checked && !!TerrainMeshLayerClass;
  const wireframe = document.getElementById("ter-mode")?.value === "wireframe";
  const wantsDrape = drapeImageryActive();
  if (!(gpu && !wireframe && wantsDrape) || !cache.elevations) {
    return [s1mBuildTileLayer(cache, exag, range)];
  }
  // Drape resolution only ratchets UP. Once a tile has been draped at some
  // subdivision, zooming out (smaller on screen -> lower s1mSubdiv) keeps
  // that already-built finer drape instead of re-draping it coarser. New
  // draping happens only on zoom-IN, when s1mSubdiv exceeds the level
  // already draped. The floor resets when the tile leaves the view
  // (refreshS1MTerrain eviction) or on collection change / terrain off.
  let n = s1mSubdiv(tile);
  const drapedN = s1mDrapedSubdivByDataset.get(tile.dataset) || 0;
  if (drapedN > n) {
    n = drapedN;
  }
  // Clamp the ratchet to the CURRENT responsive cap: zooming out lowers the
  // cap (more tiles in view), so a fine subdivision earned at deep zoom is
  // released here instead of rendering thousands of tiny sub-tiles at z10.
  n = Math.min(n, s1mSubdivMax());
  const data = cache.data;
  const bx = s1mSubBoundaries(data.width, n);
  const by = s1mSubBoundaries(data.height, n);
  // Keep already-draped sub-tiles as visual fallbacks during pan/zoom.
  // Undraped stale entries can be dropped because they only show shaded
  // terrain and cannot hide a refresh gap.
  if (cache.subtiles) {
    for (const [k, s] of [...cache.subtiles]) {
      if (
        (s.N !== n || !bboxIntersects(s.bbox, viewBbox)) &&
        !s.drapeImage &&
        !s.drapePending
      ) {
        cache.subtiles.delete(k);
      }
    }
  }
  const targetSubs = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const bbox = s1mSubTileBbox(data, bx[ix], bx[ix + 1], by[iy], by[iy + 1]);
      if (!bboxIntersects(bbox, viewBbox)) {
        continue; // viewport cull
      }
      const sub = ensureSubTile(cache, ix, iy, n, bx, by);
      ensureSubTileDrape(data, tile, sub, schedulePaint, seq);
      targetSubs.push(sub);
    }
  }
  const targetHasUndraped = targetSubs.some((sub) => !sub.drapeImage);
  let fallbackSubs = [];
  if (targetHasUndraped) {
    const candidates = [];
    for (const other of s1mTileCache.values()) {
      if (other.data.dataset === cache.data.dataset && other.subtiles) {
        candidates.push(...other.subtiles.values());
      }
    }
    fallbackSubs = candidates.filter(
      (sub) =>
        (sub.N !== n || sub.data !== cache.data) &&
        sub.drapeImage &&
        bboxIntersects(sub.bbox, viewBbox),
    );
  }
  const layers = [];
  const fallbackLayerKeys = new Set();
  for (const sub of targetSubs) {
    if (sub.drapeImage) {
      layers.push(buildS1MSubTileLayerGPU(data, sub, exag, range));
      continue;
    }
    const fallbackMatches = fallbackSubs.filter(
      (candidate) => bboxOverlapFraction(sub.bbox, candidate.bbox) > 0.01,
    );
    const fallbackCoverage = bboxCombinedOverlapFraction(
      sub.bbox,
      fallbackMatches.map((candidate) => candidate.bbox),
    );
    if (fallbackCoverage < 0.75) {
      layers.push(buildS1MSubTileLayerGPU(data, sub, exag, range));
    }
    for (const fallback of fallbackMatches) {
      const fallbackKey = `${fallback.data?.width || 0}:${fallback.N}:${fallback.ix},${fallback.iy}`;
      if (!fallbackLayerKeys.has(fallbackKey)) {
        layers.push(buildS1MSubTileLayerGPU(data, fallback, exag, range));
        fallbackLayerKeys.add(fallbackKey);
      }
    }
  }

  const isExact = cache.data.width === tile.size;
  if (isExact && !targetHasUndraped) {
    // The desired LOD is fully draped. We can now safely evict any other cached LOD sizes
    // for this dataset, since we no longer need them as fallbacks.
    for (const cacheKey of [...s1mTileCache.keys()]) {
      if (
        cacheKey.startsWith(`${tile.dataset}@`) &&
        cacheKey !== `${tile.dataset}@${tile.size}`
      ) {
        disposeS1MTileCache(s1mTileCache.get(cacheKey));
        s1mTileCache.delete(cacheKey);
      }
    }
  }

  return layers.length ? layers : [s1mBuildTileLayer(cache, exag, range)];
}

// Rebuild a tile's layers from whatever is already cached (exag / colour /
// mode toggles -- no refetch, no new draping). Uses existing sub-tiles when
// present so exaggeration stays a free uniform update.
function s1mTileLayersFromCache(cache, exag, range) {
  const gpu =
    !!document.getElementById("ter-gpu")?.checked && !!TerrainMeshLayerClass;
  const wireframe = document.getElementById("ter-mode")?.value === "wireframe";
  const wantsDrape = drapeImageryActive();
  if (gpu && !wireframe && wantsDrape && cache.subtiles?.size) {
    return [...cache.subtiles.values()].map((s) =>
      buildS1MSubTileLayerGPU(cache.data, s, exag, range),
    );
  }
  return [s1mBuildTileLayer(cache, exag, range)];
}

function clearS1MDrapeImages() {
  clearS1MDrapeCacheEntries();
  clearS1MCogTileCacheEntries();
  clearS1MDrapeSourceCache();
  for (const cache of s1mTileCache.values()) {
    delete cache.drapeImage;
    delete cache.drapeKey;
    delete cache.drapeError;
    delete cache.drapeSourceId;
    if (cache.subtiles) {
      for (const sub of cache.subtiles.values()) {
        sub.drapeImage = null;
        sub.drapeKey = null;
        sub.drapePending = null;
      }
    }
  }
}

// cache = { data, elevations, gpuMesh } built once; reused on exag change so
// the elevation texture is not recreated (elevations ref stays stable).
function buildS1MTerrainLayerGPU(cache, exag, wireframe, range) {
  const { data, elevations, gpuMesh } = cache;
  // Shared view range (not per-tile) so colour + displacement baseline are
  // consistent across tiles -- per-tile z_range makes each tile shade and
  // sit differently (patchwork).
  const [zmin, zmax] = range || data.z_range;
  const [clon, clat] = data.center_lnglat;
  return new TerrainMeshLayerClass({
    id: `s1m-terrain-${data.dataset}-${data.width}`,
    coordinateSystem: S1M_COORD.METER_OFFSETS,
    coordinateOrigin: [clon, clat, 0],
    mesh: gpuMesh.mesh,
    data: { length: 1, attributes: { positions64Low: gpuMesh.positions64Low } },
    elevationData: elevations,
    gridWidth: data.width,
    gridHeight: data.height,
    stepX: data.step[0],
    stepY: data.step[1],
    exag,
    zmin,
    zspan: Math.max(1e-6, zmax - zmin),
    nodata: data.nodata,
    drapeImage: cache.drapeImage || null,
    wireframe: !!wireframe, // draw the displaced mesh as edges
    parameters: { cullMode: "none" },
    pickable: false,
  });
}

// Token + base helper for the dedicated S1M service.
function s1mFetch(path, body) {
  const headers = { "content-type": "application/json" };
  if (S1M_DEMO_TOKEN) {
    headers["x-demo-token"] = S1M_DEMO_TOKEN;
  }
  return fetch(`${S1M_API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function s1mProjectedTilePixels(tile) {
  const bbox = tile.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return 256;
  }
  const corners = [
    map.project([bbox[0], bbox[1]]),
    map.project([bbox[2], bbox[1]]),
    map.project([bbox[2], bbox[3]]),
    map.project([bbox[0], bbox[3]]),
  ];
  let maxEdge = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i],
      b = corners[(i + 1) % corners.length];
    maxEdge = Math.max(maxEdge, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return Number.isFinite(maxEdge) ? maxEdge : 256;
}

function s1mScreenSortKey(tile) {
  const bbox = tile?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return { bottomY: -Infinity, centerX: Infinity };
  }
  const corners = [
    map.project([bbox[0], bbox[1]]),
    map.project([bbox[2], bbox[1]]),
    map.project([bbox[2], bbox[3]]),
    map.project([bbox[0], bbox[3]]),
  ];
  const ys = corners.map((p) => p.y).filter(Number.isFinite);
  const xs = corners.map((p) => p.x).filter(Number.isFinite);
  const bottomY = ys.length ? Math.max(...ys) : -Infinity;
  const centerX = xs.length
    ? xs.reduce((sum, x) => sum + x, 0) / xs.length
    : Infinity;
  return { bottomY, centerX };
}

function sortS1MTilesBottomFirst(tiles) {
  const viewportCenterX = map.getCanvas().clientWidth / 2;
  return [...tiles].sort((a, b) => {
    const ak = s1mScreenSortKey(a);
    const bk = s1mScreenSortKey(b);
    const bottomDelta = bk.bottomY - ak.bottomY;
    if (bottomDelta) {
      return bottomDelta;
    }
    return (
      Math.abs(ak.centerX - viewportCenterX) -
      Math.abs(bk.centerX - viewportCenterX)
    );
  });
}

function s1mFootprintsVisibleAtCurrentZoom() {
  return map.getZoom() >= S1M_FOOTPRINT_MIN_Z;
}

function s1mFootprintViewportKey(bbox) {
  return JSON.stringify({
    z: currentViewerTileLayerNumber(),
    bbox: bbox.map((value) => Number(value.toFixed(4))),
  });
}

function s1mFootprintPaths(tile) {
  if (Array.isArray(tile?.footprint) && tile.footprint.length > 0) {
    return tile.footprint.filter(
      (ring) => Array.isArray(ring) && ring.length >= 4,
    );
  }
  return [];
}

async function refreshS1MFootprintsLayer() {
  if (
    !toggleS1MFootprintsLayerEl?.checked ||
    !s1mFootprintsVisibleAtCurrentZoom()
  ) {
    s1mFootprintSeq += 1;
    s1mFootprintTiles = [];
    s1mFootprintKey = "";
    s1mFootprintPendingKey = "";
    updateImageryLayers();
    return;
  }
  const bbox = currentBbox();
  const key = s1mFootprintViewportKey(bbox);
  if (key === s1mFootprintKey || key === s1mFootprintPendingKey) {
    updateImageryLayers();
    return;
  }
  const seq = ++s1mFootprintSeq;
  s1mFootprintPendingKey = key;
  try {
    const c = map.getCenter();
    const response = await s1mFetch("/s1m/tiles", {
      bbox,
      max_tiles: 10000,
      center: [c.lng, c.lat],
    });
    if (!response.ok) {
      throw new Error(`S1M footprints ${response.status}`);
    }
    const tiles = (await response.json()).tiles || [];
    if (seq !== s1mFootprintSeq) {
      return;
    }
    if (
      tiles.length &&
      !tiles.some(
        (tile) => Array.isArray(tile?.footprint) && tile.footprint.length,
      )
    ) {
      console.warn(
        "S1M footprint layer received no polygon footprints; deploy the updated S1M API.",
      );
    }
    s1mFootprintTiles = tiles;
    s1mFootprintKey = key;
  } catch (error) {
    if (seq !== s1mFootprintSeq) {
      return;
    }
    s1mFootprintTiles = [];
    s1mFootprintKey = "";
    console.error("S1M footprints failed:", error);
  } finally {
    if (seq === s1mFootprintSeq) {
      s1mFootprintPendingKey = "";
      updateImageryLayers();
    }
  }
}

function naipCoverageMvtUrl() {
  const params = new URLSearchParams({
    collection: activeCollection(),
    v: NAIP_COVERAGE_MVT_VERSION,
  });
  if (stateEl.value) {
    params.set("region", stateEl.value);
  }
  if (yearEl.value) {
    params.set("year", yearEl.value);
  }
  const base = API_BASE || "";
  return `${base}/naip-coverage/{z}/{x}/{y}.mvt?${params.toString()}`;
}

function removeNaipCoverageMvtLayer() {
  if (map.getLayer(NAIP_COVERAGE_MVT_LINE_LAYER_ID)) {
    map.removeLayer(NAIP_COVERAGE_MVT_LINE_LAYER_ID);
  }
  if (map.getLayer(NAIP_COVERAGE_MVT_LAYER_ID)) {
    map.removeLayer(NAIP_COVERAGE_MVT_LAYER_ID);
  }
  if (map.getSource(NAIP_COVERAGE_MVT_SOURCE_ID)) {
    map.removeSource(NAIP_COVERAGE_MVT_SOURCE_ID);
  }
}

function updateNaipCoverageMvtLayer() {
  if (map.isStyleLoaded()) {
    removeNaipCoverageMvtLayer();
  }
  updateImageryLayers();
}

function syncFootprintLayerMode() {
  const mode = footprintLayerModeEls.find((el) => el.checked)?.value || "";
  if (toggleNaipCoverageMvtLayerEl) {
    toggleNaipCoverageMvtLayerEl.checked = mode === "coverage";
  }
  if (toggleNaipSearchFootprintsLayerEl) {
    toggleNaipSearchFootprintsLayerEl.checked = mode === "search";
  }
  updateNaipSearchFootprintsVisibility();
  updateNaipCoverageMvtLayer();
}

// Per-tile screen-error LOD. Pitched views make near tiles project wider
// than far tiles, so they get denser grids while distant tiles read lower
// DEM overviews. Quantized sizes keep cache churn bounded while panning.
function s1mLodSize(tile) {
  const px = s1mProjectedTilePixels(tile);
  if (px >= 900) {
    return 384;
  }
  if (px >= 600) {
    return 256;
  }
  if (px >= 360) {
    return 192;
  }
  if (px >= 220) {
    return 128;
  }
  if (px >= 120) {
    return 96;
  }
  return 64;
}

function s1mPaddedBbox(bounds) {
  const west = bounds.getWest(),
    south = bounds.getSouth();
  const east = bounds.getEast(),
    north = bounds.getNorth();
  const padLon = Math.max(0.01, (east - west) * 0.18);
  const padLat = Math.max(0.01, (north - south) * 0.18);
  return [
    Math.max(-180, west - padLon),
    Math.max(-90, south - padLat),
    Math.min(180, east + padLon),
    Math.min(90, north + padLat),
  ];
}

// Fixed absolute hypsometric range (metres, NAVD88): a given elevation is
// always the same colour everywhere, so tiles never need a shared value and
// nothing recolours on pan. Lowlands have less contrast than the adaptive
// mode; peaks above the max saturate to white.
const S1M_ABS_RANGE = [0, 1500];

// Shared elevation range over the cached (in-view) tiles, so colour and the
// displacement baseline are consistent tile-to-tile instead of each tile
// stretching its own min/max.
function s1mViewRange() {
  let lo = Infinity,
    hi = -Infinity;
  for (const c of s1mTileCache.values()) {
    const [a, b] = c.data.z_range;
    if (a < lo) {
      lo = a;
    }
    if (b > hi) {
      hi = b;
    }
  }
  return Number.isFinite(lo) ? [lo, Math.max(lo + 1e-6, hi)] : [0, 1];
}

// The range used for colour + displacement baseline: fixed absolute when the
// "Color" control is set to Absolute, else the adaptive shared view range.
function s1mColorRange() {
  return document.getElementById("ter-color")?.value === "absolute"
    ? S1M_ABS_RANGE
    : s1mViewRange();
}

function s1mBuildTileLayer(cache, exag, range) {
  const gpu =
    !!document.getElementById("ter-gpu")?.checked && !!TerrainMeshLayerClass;
  const wireframe = document.getElementById("ter-mode")?.value === "wireframe";
  const wantsDrape = drapeImageryActive();
  const draped = gpu && !wireframe && !!cache.drapeImage && wantsDrape;
  // deck.gl's wireframe path can render a separate line model from the
  // source mesh. For GPU displacement that source mesh is intentionally
  // flat (z=0), so wireframe appears as parallel lines below the terrain.
  // Use the CPU-baked mesh for wireframe so line vertices include z.
  return gpu && !wireframe
    ? buildS1MTerrainLayerGPU(
        draped ? cache : { ...cache, drapeImage: null },
        exag,
        false,
        range,
      )
    : buildS1MTerrainLayer(cache.data, exag, wireframe, range);
}

// Rebuild cached tile layers at the current exaggeration (a uniform change
// for GPU tiles -- texture reused) without re-querying coverage.
function rebuildS1MLayers() {
  if (!s1mActive) {
    return;
  }
  const exag = Number(document.getElementById("ter-exag").value) || 2;
  const range = s1mColorRange();
  s1mLayers = [...s1mTileCache.values()]
    .flatMap((c) => s1mTileLayersFromCache(c, exag, range))
    .filter(Boolean);
  updateImageryLayers();
}

// Fetch tiles covering the viewport, choose each tile's LOD from its
// projected screen footprint, mesh new ones, evict off-screen ones, redraw.
// A sequence guard drops stale refreshes.
async function refreshS1MTerrain() {
  if (!s1mActive) {
    return;
  }
  const summaryEl = document.getElementById("ter-summary");
  const seq = ++s1mRefreshSeq;
  const exag = Number(document.getElementById("ter-exag").value) || 2;
  const visibleBbox = currentBbox();
  const terrainBbox = s1mPaddedBbox(map.getBounds());
  const supersededPending = s1mTerrainPending.size;
  s1mFillMetrics.refreshSeq = seq;
  s1mFillMetrics.refreshStartedAt = performance.now();
  s1mFillMetrics.desired = 0;
  s1mFillMetrics.missingQueued = 0;
  s1mFillMetrics.terrainStarted = 0;
  s1mFillMetrics.terrainCompleted = 0;
  s1mFillMetrics.terrainFailed = 0;
  s1mFillMetrics.terrainStale = supersededPending;
  s1mFillMetrics.paints = 0;
  s1mFillMetrics.lastPaintAt = null;
  s1mFillMetrics.lastPaint = null;
  s1mTerrainPending.clear();
  s1mTerrainFailures.clear();
  let tiles;
  try {
    const c = map.getCenter();
    // Ask the service for coverage around the current view, then reorder
    // client-side from the bottom of the screen upward so foreground tiles
    // render and start draping first.
    const r = await s1mFetch("/s1m/tiles", {
      bbox: terrainBbox,
      max_tiles: S1M_MAX_TILES,
      center: [c.lng, c.lat],
    });
    if (!r.ok) {
      summaryEl.textContent = `Tiles error ${r.status}`;
      return;
    }
    tiles = sortS1MTilesBottomFirst((await r.json()).tiles || []);
  } catch (e) {
    summaryEl.textContent = `Tiles fetch failed: ${e?.message || e}`;
    return;
  }
  if (seq !== s1mRefreshSeq) {
    return;
  }
  s1mActiveTiles = new Map(
    tiles.map((t) => {
      const size = s1mLodSize(t);
      return [`${t.dataset}@${size}`, { ...t, size }];
    }),
  );
  s1mFillMetrics.desired = s1mActiveTiles.size;
  refreshBuildingFootprints();

  // desired preserves bottom-of-viewport first order (Map keeps insertion order).
  const desired = s1mActiveTiles;
  const desiredDatasets = new Set([...desired.values()].map((t) => t.dataset));
  // Drop tiles no longer in the viewport (stale LODs are kept as a fallback until upgraded)
  for (const key of [...s1mTileCache.keys()]) {
    const ds = key.split("@")[0];
    if (!desiredDatasets.has(ds)) {
      disposeS1MTileCache(s1mTileCache.get(key));
      s1mTileCache.delete(key);
      // Tile left the view -> reset its drape-resolution ratchet so it
      // re-enters at the zoom-appropriate subdivision next time.
      s1mDrapedSubdivByDataset.delete(ds);
    }
  }
  pruneS1MDrapeCache();

  // Paint = collect built layers for whatever's cached, bottom-first, and redraw.
  // rAF-throttled so progressive arrivals coalesce into one draw per frame.
  let paintQueued = false;
  const paint = () => {
    paintQueued = false;
    if (seq !== s1mRefreshSeq) {
      return;
    }
    const range = s1mColorRange(); // absolute: fixed; adaptive: grows as tiles arrive
    const built = [];
    let tilesDrawn = 0,
      exactDrawn = 0,
      fallbackDrawn = 0,
      missingDrawn = 0;
    let subTotal = 0,
      subTextured = 0,
      subPending = 0,
      subRefreshing = 0,
      subFailed = 0;
    for (const k of desired.keys()) {
      const tile = desired.get(k);
      if (!tile) {
        continue;
      }
      // Find the best cached entry for this tile (exact LOD, else any LOD).
      let c = s1mTileCache.get(k);
      const exact = !!c;
      if (!c) {
        for (const cacheKey of s1mTileCache.keys()) {
          if (cacheKey.startsWith(`${tile.dataset}@`)) {
            c = s1mTileCache.get(cacheKey);
            break;
          }
        }
      }
      if (!c) {
        missingDrawn += 1;
        continue;
      }
      const tileLayers = s1mBuildTileLayers(
        c,
        tile,
        exag,
        range,
        visibleBbox,
        schedulePaint,
        seq,
      );
      if (tileLayers.length) {
        tilesDrawn += 1;
      }
      if (exact) {
        exactDrawn += 1;
      } else {
        fallbackDrawn += 1;
      }
      built.push(...tileLayers);
      if (c.subtiles) {
        for (const s of c.subtiles.values()) {
          subTotal += 1;
          if (s.drapeImage) {
            subTextured += 1;
            if (s.drapePending && s.drapePending !== s.drapeKey) {
              subRefreshing += 1;
            }
          } else if (s.drapePending) {
            subPending += 1;
          } else if (s.drapeError) {
            subFailed += 1;
          }
        }
      }
    }
    s1mLayers = built;
    updateImageryLayers();
    s1mFillMetrics.paints += 1;
    s1mFillMetrics.lastPaintAt = performance.now();
    s1mFillMetrics.lastPaint = {
      seq,
      desired: desired.size,
      drawn: tilesDrawn,
      exactDrawn,
      fallbackDrawn,
      missing: missingDrawn,
      drapeSubtiles: subTotal,
      drapeTextured: subTextured,
      drapePending: subPending,
      drapeRefreshing: subRefreshing,
      drapeFailed: subFailed,
    };
    const sizes = [...new Set([...desired.values()].map((t) => t.size))].sort(
      (a, b) => a - b,
    );
    const sizeText =
      sizes.length <= 1
        ? `${sizes[0] ?? "-"}`
        : `${sizes[0]}-${sizes[sizes.length - 1]}`;
    const canRenderDrape =
      !!document.getElementById("ter-gpu")?.checked &&
      document.getElementById("ter-mode")?.value !== "wireframe" &&
      drapeImageryActive();
    const drapeText = canRenderDrape
      ? ` · ${subTextured}/${subTotal} drape sub-tiles`
      : "";
    const drapeErrorText =
      canRenderDrape && s1mDrapeSourceError ? ` · drape search failed` : "";
    // Imagery is selected but the drape is deferred (small-COG collection,
    // zoomed out): show shaded terrain and tell the user why + how to fix.
    const drapeGated =
      document.getElementById("ter-surface")?.value === "imagery" &&
      isSmallCogCollection() &&
      (map.getZoom() || 0) < S1M_SMALL_COG_DRAPE_MIN_ZOOM;
    const drapeGateText = drapeGated
      ? ` · shaded — imagery drapes at z≥${S1M_SMALL_COG_DRAPE_MIN_ZOOM} (zoom in)`
      : "";
    summaryEl.textContent = desired.size
      ? `${tilesDrawn}/${desired.size} S1M tiles · grid ${sizeText} · ${exag}× exag${drapeText}${drapeErrorText}${drapeGateText}`
      : "No S1M coverage in view (partial coverage, still expanding).";
    // Re-seat footprints as elevation tiles arrive so bases catch up to the relief.
    if (terBuildingsEl?.checked && buildingFeatureData) {
      applyBuildingExtrusionZ();
    }
  };
  const schedulePaint = () => {
    if (!paintQueued) {
      paintQueued = true;
      requestAnimationFrame(paint);
    }
  };

  schedulePaint(); // show already-cached tiles immediately

  // Fetch missing tiles bottom-of-viewport first with bounded concurrency,
  // painting each arrival immediately so its imagery drape can start before
  // the rest of the S1M queue finishes.
  const missing = [...desired].filter(([k]) => !s1mTileCache.has(k));
  s1mFillMetrics.missingQueued = missing.length;
  let idx = 0;
  const worker = async () => {
    while (idx < missing.length) {
      if (seq !== s1mRefreshSeq) {
        return;
      }
      const [key, t] = missing[idx++];
      try {
        const tf0 = performance.now();
        s1mFillMetrics.terrainStarted += 1;
        s1mTerrainPending.set(key, {
          seq,
          dataset: t.dataset,
          size: t.size,
          startedAt: tf0,
        });
        let data;
        try {
          // Read the DEM overview directly in the browser (no /s1m/terrain).
          data = await readS1MTerrainClient(t.dataset, t.size);
        } catch (readError) {
          if (seq !== s1mRefreshSeq) {
            return; // Clear/newer refresh superseded us
          }
          const message = `terrain read: ${readError?.message || readError}`;
          s1mFillMetrics.terrainFailed += 1;
          s1mTerrainFailures.set(key, {
            seq,
            dataset: t.dataset,
            size: t.size,
            message,
            at: performance.now(),
          });
          continue;
        }
        if (seq !== s1mRefreshSeq) {
          return; // Clear/newer refresh superseded us
        }
        const tf1 = performance.now();
        const elevations = data.elev;
        const gpuMesh = s1mGpuMesh(
          data.width,
          data.height,
          data.step[0],
          data.step[1],
          data.center_lnglat[0],
        );
        const tf2 = performance.now();
        s1mBench.terrainFetchMs += tf1 - tf0;
        s1mBench.terrainFetchN += 1;
        s1mBench.meshMs += tf2 - tf1;
        s1mBench.meshN += 1;
        s1mTileCache.set(key, { data, elevations, gpuMesh, layer: null });
        s1mFillMetrics.terrainCompleted += 1;
        pruneS1MDrapeCache();
        paint(); // paint sub-tiles + start draping this newly arrived tile now
      } catch (error) {
        if (seq !== s1mRefreshSeq) {
          return;
        }
        s1mFillMetrics.terrainFailed += 1;
        s1mTerrainFailures.set(key, {
          seq,
          dataset: t.dataset,
          size: t.size,
          message: error?.message || String(error),
          at: performance.now(),
        });
      } finally {
        if (s1mTerrainPending.get(key)?.seq === seq) {
          s1mTerrainPending.delete(key);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

const s1mDebouncedRefresh = (() => {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(refreshS1MTerrain, 300);
  };
})();

async function enableS1MTerrain() {
  const summaryEl = document.getElementById("ter-summary");
  const runEl = document.getElementById("ter-run");
  try {
    runEl.disabled = true;
    summaryEl.textContent = "Loading S1M terrain…";

    updateImagery(lastSearchFeatures);
    updateReferenceRasterLayers();

    await initImagerySupport();
    if (!S1M_COORD) {
      summaryEl.textContent = "Terrain modules unavailable.";
      return;
    }
    s1mActive = true;
    if (!s1mMoveHandler) {
      s1mMoveHandler = s1mDebouncedRefresh;
      map.on("moveend", s1mMoveHandler);
    }
    await refreshS1MTerrain();
  } catch (err) {
    summaryEl.textContent = `Terrain load failed: ${err?.message || err}`;
  } finally {
    runEl.disabled = false;
  }
}

function clearS1MTerrain() {
  s1mActive = false;
  s1mRefreshSeq++; // invalidate any in-flight refresh
  if (s1mMoveHandler) {
    map.off("moveend", s1mMoveHandler);
    s1mMoveHandler = null;
  }
  for (const cache of s1mTileCache.values()) {
    disposeS1MTileCache(cache);
  }
  s1mTileCache.clear();
  clearS1MDrapeCacheEntries();
  s1mDrapedSubdivByDataset.clear();
  clearS1MCogTileCacheEntries();
  clearGeotiffSourceCache();
  clearS1MDrapeSourceCache();
  drapeProjectionCache = new WeakMap();
  s1mTerrainPending.clear();
  s1mTerrainFailures.clear();
  s1mActiveTiles.clear();
  resetS1MDrapeMetrics();
  s1mLayers = [];
  clearBuildingFootprints();
  updateImageryLayers();
  const el = document.getElementById("ter-summary");
  if (el) {
    el.textContent = "No terrain loaded.";
  }
  const metricsEl = document.getElementById("ter-metrics");
  if (metricsEl) {
    metricsEl.textContent = "Drape metrics unavailable.";
  }
}

function getBasemapSourceCacheEntries() {
  const style = map.style;
  if (!style) {
    return [];
  }
  const sourceCaches = style.sourceCaches || style._sourceCaches || {};
  const ignoredSources = new Set(["naip-search"]);
  return Object.entries(sourceCaches).filter(
    ([sourceId]) => !ignoredSources.has(sourceId),
  );
}

function updateReferenceRasterLayers() {
  const usgsVisible = toggleUsgsNaipWmsLayerEl.checked;
  if (map.getLayer("usgs-naip-wms-layer")) {
    map.setLayoutProperty(
      "usgs-naip-wms-layer",
      "visibility",
      usgsVisible ? "visible" : "none",
    );
  }
  moveMapLibreVectorLayersToTop();
}

function updateResolutionDebug(_features, imagerySources) {
  if (!imagerySources.length) {
    resolutionDebugEl.textContent = "Resolution debug unavailable.";
    return;
  }

  const topSource = imagerySources[0];
  const properties = topSource?.properties || {};
  const gsd = Number(properties.gsd);
  const mapMpp = mapMetersPerPixel();

  if (!Number.isFinite(gsd) || !Number.isFinite(mapMpp) || gsd <= 0) {
    resolutionDebugEl.textContent = "Resolution debug unavailable.";
    return;
  }

  const overviewEstimate = Math.max(
    0,
    Math.ceil(Math.log2(Math.max(mapMpp / gsd, 1))),
  );
  const fullRes = overviewEstimate === 0;
  const topYear = properties["naip:year"] ?? "?";
  const topId = properties["grid:code"] || topSource?.id || "?";

  resolutionDebugEl.innerHTML = `
    <div>Top source: <strong>${topId}</strong></div>
    <div>Year ${topYear} · gsd ${gsd.toFixed(2)} m/px · map ${mapMpp.toFixed(2)} m/px</div>
    <div>Estimated overview level ${overviewEstimate} · full res ${fullRes ? "yes" : "no"}</div>
  `;
}

async function initImagerySupport({ retryAfterMemoryRelease = true } = {}) {
  if (deckOverlay && MosaicLayerClass && COGLayerClass) {
    return;
  }
  try {
    const [
      { MapboxOverlay },
      geoLayersModule,
      geotiffModule,
      geotiffCoreModule,
      rasterGpuModule,
      { lngLatToWorld },
      meshLayersModule,
      deckCoreModule,
      rasterModule,
      layersModule,
    ] = await Promise.all([
      import("@deck.gl/mapbox"),
      import("@deck.gl/geo-layers"),
      import("@s3-cog/deck.gl-geotiff"),
      import("@s3-cog/geotiff"),
      import("@s3-cog/deck.gl-raster/gpu-modules"),
      import("@math.gl/web-mercator"),
      import("@deck.gl/mesh-layers"),
      import("@deck.gl/core"),
      import("@s3-cog/deck.gl-raster"),
      import("@deck.gl/layers"),
    ]);
    MVTLayerClass = geoLayersModule.MVTLayer;
    MosaicLayerClass = geotiffModule.MosaicLayer;
    COGLayerClass = geotiffModule.COGLayer;
    SimpleMeshLayerClass = meshLayersModule.SimpleMeshLayer;
    TerrainMeshLayerClass = rasterModule.TerrainMeshLayer;
    PathLayerClass = layersModule.PathLayer;
    S1M_COORD = deckCoreModule.COORDINATE_SYSTEM;
    CutlineBboxModule = rasterGpuModule.CutlineBbox;
    lngLatToWorldFn = lngLatToWorld;
    addAlphaChannelFn = geotiffModule.addAlphaChannel;
    CreateTextureModule = rasterGpuModule.CreateTexture;
    window.GeoTIFFCoreClass = geotiffCoreModule.GeoTIFF;
    if (!s1mDrapeConcurrencyLimiter && geotiffCoreModule.PerOriginSemaphore) {
      // Drape build tuning: COG range reads dominate the summed subtile
      // durations. S3 multiplexes over HTTP/2 and the presigned URL is
      // cached, so a higher ceiling parallelises visible sub-tile reads.
      // Raising the old ceiling of 12 improved time-to-fully-draped in
      // local benchmarks, but 16 vs 20 was indistinguishable (run-to-run
      // network + persistent chunk-cache warmth swamps the difference), so
      // use the lower of the two: these requests compete with other
      // same-origin imagery reads (the flat-map COG tiles share the S3
      // origin) while a cold drape fills.
      s1mDrapeConcurrencyLimiter = new geotiffCoreModule.PerOriginSemaphore({
        maxRequests: 16,
      });
    }
    deckOverlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(deckOverlay);
    imageryInitErrorMessage = null;
    imageryStatusEl.textContent = "Imagery modules loaded.";
    imageryStatusEl.className = "small status-ok";
    if (Array.isArray(lastSearchFeatures) && lastSearchFeatures.length > 0) {
      updateImagery(lastSearchFeatures);
    }
  } catch (error) {
    console.error("Failed to load imagery modules", error);
    if (retryAfterMemoryRelease && isAllocationError(error)) {
      releaseS1MDrapeMemory();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return initImagerySupport({ retryAfterMemoryRelease: false });
    }
    imageryInitErrorMessage = error?.message || String(error);
    imageryStatusEl.textContent = `Imagery modules failed to load; footprints-only mode. ${error?.message || error}`;
    imageryStatusEl.className = "small status-warn";
  }
}

function currentBbox() {
  const bounds = map.getBounds();
  return [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];
}

function bboxAtZoom(maxZoom) {
  const zoom = map.getZoom();
  if (zoom >= maxZoom) {
    return currentBbox();
  }
  const canvas = map.getCanvas();
  const center = map.getCenter();
  // Avoid accidental whole-world searches if the map has not sized yet.
  if (!(canvas.width > 0 && canvas.height > 0)) {
    return currentBbox();
  }

  const tileSize = 512;
  const worldSize = tileSize * 2 ** maxZoom;
  const mercator = maplibregl.MercatorCoordinate.fromLngLat(center);
  const dx = canvas.width / 2 / worldSize;
  const dy = canvas.height / 2 / worldSize;
  const westX = Math.max(0, mercator.x - dx);
  const eastX = Math.min(1, mercator.x + dx);
  const northY = Math.max(0, mercator.y - dy);
  const southY = Math.min(1, mercator.y + dy);
  const lng = (x) => x * 360 - 180;
  const lat = (y) => {
    const n = Math.PI * (1 - 2 * y);
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  };
  return [lng(westX), lat(southY), lng(eastX), lat(northY)];
}

function switchTab(tabName) {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
  if (tabName === "ingest") {
    switchIngestMode(ingestMode);
  }
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
}

function renderKeyValue(target, values) {
  target.innerHTML = "";
  values.forEach(([key, value]) => {
    const keyEl = document.createElement("div");
    keyEl.textContent = key;
    const valueEl = document.createElement("div");
    if (typeof value === "string") {
      valueEl.textContent = value;
    } else {
      valueEl.textContent = value == null ? "—" : String(value);
    }
    target.appendChild(keyEl);
    target.appendChild(valueEl);
  });
}

function statusLabel(ok, detail) {
  if (ok) {
    return `ok${detail ? ` · ${detail}` : ""}`;
  }
  return `failed${detail ? ` · ${detail}` : ""}`;
}

async function refreshEnvironment() {
  environmentChecksEl.textContent = "Loading environment status…";
  environmentConfigEl.textContent = "";
  try {
    const response = await apiFetch("/environment");
    const data = await response.json();
    renderKeyValue(
      environmentChecksEl,
      [
        ["auth mode", data.auth_mode],
        [
          "S3 object access",
          statusLabel(
            data.s3_access_status?.ok,
            data.s3_access_status?.error ||
              `${data.s3_access_status?.bucket || ""}${data.s3_access_status?.request_payer ? ` (${data.s3_access_status.request_payer})` : ""}`,
          ),
        ],
        [
          "manifest index",
          statusLabel(
            data.manifest_index?.ok,
            data.manifest_index?.error ||
              `${data.manifest_index?.path || "—"}${data.manifest_index?.file_count != null ? ` · ${data.manifest_index.file_count} files` : ""}`,
          ),
        ],
        (() => {
          const mi = data.manifest_index || {};
          if (mi.source_modified == null && mi.freshness_error == null) {
            return null;
          }
          const fmt = (s) => (s ? String(s).slice(0, 10) : "—");
          const detail = mi.freshness_error
            ? mi.freshness_error
            : `${mi.source || "—"} · source ${fmt(mi.source_modified)} · index ${fmt(mi.index_built)}`;
          // ok when NOT stale; statusLabel renders the stale case as a warning.
          return [
            "manifest freshness",
            statusLabel(mi.stale === false, detail),
          ];
        })(),
        ["DB health", statusLabel(data.db?.ok, data.db?.error)],
        [
          "EarthSearch",
          statusLabel(
            data.earthsearch?.ok,
            data.earthsearch?.error || data.earthsearch?.url,
          ),
        ],
        [
          "AWS identity",
          data.auth_identity?.ok
            ? `${data.auth_identity?.arn || "unknown"}`
            : data.auth_identity?.error || "unavailable",
        ],
        // Where the write token lives (never the value). The viewer does not
        // ship the token, so this is how an operator finds it without digging
        // through the deploy scripts.
        data.ingest_token_required
          ? ["ingest token", data.ingest_token_hint || "required"]
          : null,
      ].filter(Boolean),
    );
    renderKeyValue(
      environmentConfigEl,
      Object.entries(data.effective_config || {}),
    );
  } catch (error) {
    environmentChecksEl.textContent = `Failed to load environment status: ${error?.message || error}`;
    environmentConfigEl.textContent = "";
  }
}

function sanitizeCollectionId(value) {
  return (
    (value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "s3-source"
  );
}

function ingestSourcePayload() {
  const maxWorkers = Number(ingestWorkersEl.value || 16);
  const accessKey = ingestAccessKeyEl.value.trim();
  const secretKey = ingestSecretKeyEl.value.trim();

  if (ingestMode === "catalog") {
    const collection = ingestCatalogCollectionEl.value;
    const region = ingestCatalogRegionEl.value;
    const yearRaw = ingestCatalogYearEl.value;
    const year = yearRaw ? Number(yearRaw) : NaN;
    const strategy = ingestCatalogStrategyEl.value;

    if (!collection) {
      throw new Error("Select a collection.");
    }
    if (!region) {
      throw new Error("Select a state/region.");
    }
    if (!Number.isInteger(year)) {
      throw new Error("Select a year.");
    }

    const payload = {
      collection,
      state: region,
      year,
      strategy,
      limit_per_partition: ingestLimitPerPartition(),
      max_workers: maxWorkers,
    };
    if (accessKey) {
      payload.source_access_key_id = accessKey;
    }
    if (secretKey) {
      payload.source_secret_access_key = secretKey;
    }
    return payload;
  } else {
    const bucket = ingestCustomBucketEl.value.trim();
    const prefix = ingestCustomPrefixEl.value.trim().replace(/^\/+/, "");
    const region = ingestCustomRegionEl.value.trim().toLowerCase();
    const yearRaw = ingestCustomYearEl.value.trim();
    const year = yearRaw ? Number(yearRaw) : NaN;
    const access = ingestCustomAccessEl.value || "public";
    const strategy = ingestCustomStrategyEl.value || "manifest-cog-headers";
    const customCol = ingestCustomCollectionEl.value.trim();

    if (!bucket) {
      throw new Error("Enter an S3 bucket.");
    }
    if (!region) {
      throw new Error("Enter a region code.");
    }
    if (!Number.isInteger(year)) {
      throw new Error("Enter a numeric year.");
    }

    const bareBucket = bucket.startsWith("s3://")
      ? bucket.slice(5).split("/")[0]
      : bucket;
    const registered = collectionFeatures.find((p) => p.bucket === bareBucket);
    const colId =
      customCol ||
      (registered ? registered.id : sanitizeCollectionId(bareBucket));

    const payload = {
      collection: colId,
      source_bucket: bucket,
      source_prefix: prefix,
      source_region: region,
      source_year: year,
      source_access: access,
      state: region,
      year,
      strategy,
      limit_per_partition: ingestLimitPerPartition(),
      max_workers: maxWorkers,
    };
    if (accessKey) {
      payload.source_access_key_id = accessKey;
    }
    if (secretKey) {
      payload.source_secret_access_key = secretKey;
    }
    return payload;
  }
}

async function pollIngestStatus(jobId) {
  if (!jobId) {
    return;
  }
  try {
    const response = await apiFetch(`/ingest/status/${jobId}`);
    const data = await response.json();
    const lines = Array.isArray(data.logs) ? data.logs : [];
    ingestSummaryEl.textContent = `Job ${jobId} · ${data.status}${data.error ? ` · ${data.error}` : ""}`;
    ingestLogsEl.textContent = lines.length ? lines.join("\n") : "No logs yet.";
    if (data.status === "running") {
      ingestStatusPollId = window.setTimeout(
        () => pollIngestStatus(jobId),
        1500,
      );
    } else {
      ingestStatusPollId = null;
      await refreshEnvironment();
      // A completed ingest adds a state/year to the lake, so refresh the
      // Viewer's State->Year availability dropdowns to surface it (the
      // currently-selected state is preserved by refreshAvailability).
      if (data.status === "completed") {
        await refreshAvailability();
      }
    }
  } catch (error) {
    ingestSummaryEl.textContent = `Failed to fetch ingest status: ${error?.message || error}`;
    ingestStatusPollId = null;
  }
}

async function getIngestConfig() {
  if (ingestModeCache) {
    return ingestModeCache;
  }
  try {
    const response = await apiFetch("/environment");
    const data = await response.json();
    const mode =
      data.ingest_mode === "sync" || data.ingest_mode === "disabled"
        ? data.ingest_mode
        : "async";
    // ingest_url (set on the read-only Lambda) points the viewer at the
    // dedicated container ingest function; falls back to same origin.
    ingestModeCache = { mode, url: data.ingest_url || "" };
  } catch (_error) {
    // Default to async (local/Docker) if the probe fails.
    ingestModeCache = { mode: "async", url: "" };
  }
  return ingestModeCache;
}

// Clamp the panel's "Max per partition" to [0, INGEST_LIMIT_MAX]. 0 means
// unlimited; an empty field defaults to 500. The server must allow the same
// ceiling (S3_COG_SYNC_INGEST_MAX_LIMIT) for the sync path; large values are
// really for the async/background job (no per-request timeout).
function ingestLimitPerPartition() {
  const valStr = ingestLimitEl.value.trim();
  if (valStr === "") {
    return INGEST_SYNC_MAX_LIMIT;
  }
  const requested = Number(valStr);
  if (Number.isNaN(requested)) {
    return INGEST_SYNC_MAX_LIMIT;
  }
  const val = Math.trunc(requested);
  if (val === 0) {
    return 0;
  }
  return Math.min(Math.max(1, val), INGEST_LIMIT_MAX);
}

function ingestRequestHeaders() {
  const headers = { "content-type": "application/json" };
  const token = ingestToken();
  if (token) {
    headers["x-ingest-token"] = token;
  }
  return headers;
}

async function runIngest() {
  let payload;
  try {
    payload = ingestSourcePayload();
  } catch (error) {
    ingestSummaryEl.textContent = error?.message || String(error);
    return;
  }
  if (ingestStatusPollId) {
    window.clearTimeout(ingestStatusPollId);
    ingestStatusPollId = null;
  }
  ingestSummaryEl.textContent = "Starting ingest…";
  ingestLogsEl.textContent = "Starting ingest…";

  const { mode, url } = await getIngestConfig();
  // A configured ingest_url (container ingest function) takes precedence:
  // POST cross-origin there even though this origin is read-only.
  if (url) {
    await runIngestSync(url);
    return;
  }
  if (mode === "disabled") {
    ingestSummaryEl.textContent =
      "Ingest is not available on this deployment (read-only) and no ingest function is configured.";
    ingestLogsEl.textContent = "";
    return;
  }
  if (mode === "sync") {
    await runIngestSync("");
    return;
  }

  try {
    const response = await apiFetch("/ingest/run", {
      method: "POST",
      headers: ingestRequestHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      ingestSummaryEl.textContent = `Error starting ingest: ${response.status} ${text}`;
      ingestLogsEl.textContent = "";
      return;
    }
    const data = await response.json();
    activeIngestJobId = data.job_id;
    await pollIngestStatus(activeIngestJobId);
  } catch (error) {
    console.error("Ingest failed to start:", error);
    ingestSummaryEl.textContent = `Failed to start ingest due to network error: ${error?.message || error}`;
    ingestLogsEl.textContent = "";
  }
}

// Lambda path: a single blocking request that returns the ingest result.
// No job id, no polling -- the response IS the outcome.
async function runIngestSync(baseUrl = "") {
  ingestSummaryEl.textContent = "Running ingest (synchronous)…";
  ingestLogsEl.textContent = "Running ingest (synchronous)…";
  try {
    const payload = ingestSourcePayload();
    const response = await fetch(`${baseUrl || API_BASE}/ingest/run-sync`, {
      method: "POST",
      headers: ingestRequestHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      ingestSummaryEl.textContent = `Ingest failed: ${response.status} ${data.detail || ""}`;
      ingestLogsEl.textContent = "";
      return;
    }
    if (data.status === "no_data") {
      ingestSummaryEl.textContent = `No data · ${data.state} ${data.year} · ${data.detail || ""}`;
      ingestLogsEl.textContent = JSON.stringify(data, null, 2);
      return;
    }
    ingestSummaryEl.textContent = `Completed · ${data.state} ${data.year} · ${data.rows_ingested} rows · ${data.elapsed_ms} ms`;
    ingestLogsEl.textContent = JSON.stringify(data, null, 2);
    await refreshEnvironment();
    await refreshAvailability();
  } catch (error) {
    console.error("Sync ingest failed:", error);
    ingestSummaryEl.textContent = `Failed to run ingest: ${error?.message || error}`;
    ingestLogsEl.textContent = "";
  }
}

function readTimingHeaders(response) {
  return {
    featureCount: Number(response.headers.get("x-search-feature-count") || 0),
    sqlMs: Number(response.headers.get("x-search-sql-ms") || 0),
    signMs: Number(response.headers.get("x-search-sign-ms") || 0),
    rewriteMs: Number(response.headers.get("x-search-rewrite-ms") || 0),
    totalMs: Number(response.headers.get("x-search-total-ms") || 0),
    cacheHits: Number(response.headers.get("x-search-presign-cache-hits") || 0),
    cacheMisses: Number(
      response.headers.get("x-search-presign-cache-misses") || 0,
    ),
  };
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`;
}

function renderTimingSummary(timings) {
  // Each line is one phase of the round trip, in the order it happens:
  // server work (DB query -> build JSON), then browser work (download ->
  // parse -> draw). Image URLs are no longer signed inline in /search --
  // footprints are decoupled from imagery, so each COG is signed lazily
  // via /sign as deck.gl loads it (line 2 reports that, growing as tiles
  // stream in after this summary first renders). "Server total" is what
  // the API spent; "round trip" is what you waited for the footprints.
  const signNote =
    signCallCount > 0
      ? `${signCallCount} tile${signCallCount === 1 ? "" : "s"} signed, ${formatMs(signTotalMs)} total`
      : "none yet — tiles sign as they load";
  timingSummaryEl.innerHTML = `
    <div style="margin-bottom:4px;"><strong>Where the time went (this search):</strong></div>
    <div><strong>1. Server — find footprints:</strong> ${formatMs(timings.server.sqlMs)} <span class="muted">(database/lake query)</span></div>
    <div><strong>2. Client — sign image URLs:</strong> <span class="muted">lazy, per tile via /sign (${signNote})</span></div>
    <div><strong>3. Server — build response:</strong> ${formatMs(timings.server.rewriteMs)} <span class="muted">(assemble GeoJSON)</span> → server total ${formatMs(timings.server.totalMs)}</div>
    <div><strong>4. Browser — download + parse:</strong> ${formatMs(timings.client.fetchMs)} fetch, ${formatMs(timings.client.jsonMs)} parse</div>
    <div><strong>5. Browser — draw:</strong> list ${formatMs(timings.client.resultsMs)} · footprints ${formatMs(timings.client.footprintsMs)} · imagery ${formatMs(timings.client.imageryMs)}</div>
    <div style="margin-top:4px;"><strong>Round trip (footprints on screen):</strong> ${formatMs(timings.client.totalMs)}</div>
  `;
}

function logTimingBreakdown(timings) {
  console.groupCollapsed(
    `[naip timings] ${timings.trigger} features=${timings.server.featureCount} total=${formatMs(timings.client.totalMs)}`,
  );
  console.table({
    client_fetch_ms: timings.client.fetchMs.toFixed(1),
    client_json_ms: timings.client.jsonMs.toFixed(1),
    client_results_ms: timings.client.resultsMs.toFixed(1),
    client_footprints_ms: timings.client.footprintsMs.toFixed(1),
    client_imagery_ms: timings.client.imageryMs.toFixed(1),
    client_total_ms: timings.client.totalMs.toFixed(1),
    client_sign_calls: signCallCount,
    client_sign_ms: signTotalMs.toFixed(1),
    server_sql_ms: timings.server.sqlMs.toFixed(1),
    server_sign_ms: timings.server.signMs.toFixed(1),
    server_rewrite_ms: timings.server.rewriteMs.toFixed(1),
    server_total_ms: timings.server.totalMs.toFixed(1),
    presign_cache_hits: timings.server.cacheHits,
    presign_cache_misses: timings.server.cacheMisses,
  });
  console.log("bbox", timings.bbox);
  console.groupEnd();
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedCounts(map, limit = 8) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);
}

function renderMetricRow(label, value) {
  const row = document.createElement("div");
  row.className = "item";
  const title = document.createElement("strong");
  title.textContent = label;
  const body = document.createElement("div");
  body.className = "small muted";
  body.textContent = value;
  row.appendChild(title);
  row.appendChild(body);
  resultsEl.appendChild(row);
}

function renderResults(features) {
  resultsEl.innerHTML = "";
  if (!features.length) {
    renderMetricRow("Returned footprints", "0");
    return;
  }

  const regions = new Map();
  const years = new Map();
  const regionYears = new Map();
  let minGsd = null;
  let maxGsd = null;
  let minDate = null;
  let maxDate = null;
  let imageAssetCount = 0;

  features.forEach((feature) => {
    const properties = feature.properties || {};
    const region = String(
      properties.region ?? properties["naip:state"] ?? "unknown",
    ).toLowerCase();
    const year = String(
      properties.year ?? properties["naip:year"] ?? "unknown",
    );
    incrementCount(regions, region);
    incrementCount(years, year);
    incrementCount(regionYears, `${region} ${year}`);

    const gsd = Number(properties.gsd);
    if (Number.isFinite(gsd)) {
      minGsd = minGsd == null ? gsd : Math.min(minGsd, gsd);
      maxGsd = maxGsd == null ? gsd : Math.max(maxGsd, gsd);
    }

    const date = properties.datetime
      ? String(properties.datetime).slice(0, 10)
      : null;
    if (date) {
      minDate = minDate == null ? date : date < minDate ? date : minDate;
      maxDate = maxDate == null ? date : date > maxDate ? date : maxDate;
    }

    if (feature.assets?.image?.href) {
      imageAssetCount += 1;
    }
  });

  const yearValues = Array.from(years.keys()).sort(
    (a, b) => Number(b) - Number(a),
  );
  const topRegions = sortedCounts(regions)
    .map(([region, count]) => `${region}: ${count}`)
    .join(" | ");
  const topRegionYears = sortedCounts(regionYears)
    .map(([key, count]) => `${key}: ${count}`)
    .join(" | ");
  const gsdText =
    minGsd == null
      ? "unavailable"
      : minGsd === maxGsd
        ? `${minGsd} m`
        : `${minGsd}-${maxGsd} m`;
  const dateText =
    minDate && maxDate
      ? minDate === maxDate
        ? minDate
        : `${minDate} to ${maxDate}`
      : "unavailable";

  renderMetricRow(
    "Returned footprints",
    `${features.length} total | ${imageAssetCount} with image assets`,
  );
  renderMetricRow(
    "Regions",
    `${regions.size} region${regions.size === 1 ? "" : "s"} | ${topRegions || "none"}`,
  );
  renderMetricRow(
    "Years",
    `${yearValues.length} year${yearValues.length === 1 ? "" : "s"} | ${yearValues.join(", ") || "none"}`,
  );
  renderMetricRow("Resolution", gsdText);
  renderMetricRow("Acquisition dates", dateText);
  renderMetricRow("Top region/year groups", topRegionYears || "none");
}

function footprintSignature(features) {
  return JSON.stringify(
    features.map((feature) => ({
      id: feature?.id ?? null,
      bbox: feature?.bbox ?? null,
    })),
  );
}

function imagerySignature(features) {
  return JSON.stringify(
    features.map((feature) => ({
      id: feature?.id ?? null,
      href: feature?.assets?.image?.href ?? null,
      bbox: feature?.bbox ?? null,
    })),
  );
}

// Live COG count on the "Search results" option, plus an amber hint when the
// result hit the Max limit -- the concrete cue for why the Coverage map
// exists (search truncates at scale; coverage doesn't).
function updateSearchResultsCount() {
  const countEl = document.getElementById("search-results-count");
  const hintEl = document.getElementById("search-results-cap-hint");
  if (!countEl) {
    return;
  }
  const n = (lastSearchFeatures || []).length;
  const limit = Number(limitEl.value || SEARCH_LIMIT_DEFAULT);
  const capped = n > 0 && n >= limit;
  countEl.textContent =
    n === 0
      ? ""
      : `· ${n.toLocaleString()} COG${n === 1 ? "" : "s"}${capped ? " (capped)" : ""}`;
  countEl.style.color = capped ? "#fbbf24" : "";
  if (hintEl) {
    hintEl.style.display = capped ? "" : "none";
  }
}

function updateNaipSearchFootprintsVisibility() {
  const visibility = toggleNaipSearchFootprintsLayerEl?.checked
    ? "visible"
    : "none";
  for (const layerId of ["naip-search-fill", "naip-search-line"]) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
  moveMapLibreVectorLayersToTop();
}

function updateMap(features) {
  const startedAt = performance.now();
  const nextSignature = footprintSignature(features);
  if (nextSignature === currentFootprintSignature) {
    updateNaipSearchFootprintsVisibility();
    return { skipped: true, durationMs: performance.now() - startedAt };
  }

  const sourceData = {
    type: "FeatureCollection",
    features,
  };

  if (map.getSource("naip-search")) {
    map.getSource("naip-search").setData(sourceData);
    currentFootprintSignature = nextSignature;
    updateNaipSearchFootprintsVisibility();
    return { skipped: false, durationMs: performance.now() - startedAt };
  }

  map.addSource("naip-search", {
    type: "geojson",
    data: sourceData,
  });
  currentFootprintSignature = nextSignature;

  map.addLayer({
    id: "naip-search-fill",
    type: "fill",
    source: "naip-search",
    layout: {
      visibility: toggleNaipSearchFootprintsLayerEl?.checked
        ? "visible"
        : "none",
    },
    paint: {
      "fill-color": SEARCH_RESULT_FOOTPRINT_COLOR,
      "fill-opacity": 0,
    },
  });

  map.addLayer({
    id: "naip-search-line",
    type: "line",
    source: "naip-search",
    layout: {
      visibility: toggleNaipSearchFootprintsLayerEl?.checked
        ? "visible"
        : "none",
    },
    paint: {
      "line-color": SEARCH_RESULT_FOOTPRINT_COLOR,
      "line-width": 1,
      "line-opacity": 0.5,
    },
  });
  updateNaipSearchFootprintsVisibility();
  return { skipped: false, durationMs: performance.now() - startedAt };
}

function updateImagery(features) {
  const startedAt = performance.now();
  const imagerySources = features.filter(
    (feature) => feature?.assets?.image?.href && Array.isArray(feature?.bbox),
  );
  const nextImageryHrefs = imagerySources.map(
    (feature) => feature.assets.image.href,
  );
  const nextSignature = imagerySignature(imagerySources);
  const _zoomNow = map.getZoom();

  if (!deckOverlay || !MosaicLayerClass || !COGLayerClass) {
    imageryStatusEl.textContent = imageryInitErrorMessage
      ? `Footprints loaded. Imagery module unavailable. ${imageryInitErrorMessage}`
      : "Footprints loaded. Imagery module unavailable.";
    imageryStatusEl.className = "small status-warn";
    updateImageryLayers();
    return { skipped: true, durationMs: performance.now() - startedAt };
  }

  const showCog = toggleCogEl.checked;
  if (!showCog) {
    updateImageryLayers();
    currentImagerySignature = null;
    imageryStatusEl.textContent = "COG Layer is disabled.";
    imageryStatusEl.className = "small status-warn";
    return { skipped: false, durationMs: performance.now() - startedAt };
  }

  if (!imagerySources.length) {
    updateImageryLayers();
    currentImagerySignature = nextSignature;
    imageryStatusEl.textContent =
      "No imagery sources available in current response.";
    imageryStatusEl.className = "small status-warn";
    updateResolutionDebug(features, imagerySources);
    return { skipped: false, durationMs: performance.now() - startedAt };
  }

  if (nextSignature === currentImagerySignature) {
    imageryStatusEl.textContent = `Imagery unchanged for ${imagerySources.length} returned items.`;
    imageryStatusEl.className = "small status-ok";
    updateResolutionDebug(features, imagerySources);
    updateImageryLayers();
    return { skipped: true, durationMs: performance.now() - startedAt };
  }

  imageryRevision += 1;
  clearS1MDrapeImages();
  updateImageryLayers();
  if (s1mActive && drapeImageryActive()) {
    refreshS1MTerrain();
  }
  currentImagerySignature = nextSignature;
  currentImageryHrefs = nextImageryHrefs;
  imageryStatusEl.textContent = `Imagery rendering enabled for ${imagerySources.length} of ${features.length} returned items.`;
  imageryStatusEl.className = "small status-ok";
  updateResolutionDebug(features, imagerySources);
  return { skipped: false, durationMs: performance.now() - startedAt };
}

async function runSearch(trigger = "manual") {
  const clientStartedAt = performance.now();
  const searchToken = ++activeSearchToken;
  // Reset per-search client-side signing counters + the re-sign guard so
  // the timing panel and 403-retry logic scope to this search.
  signCallCount = 0;
  signTotalMs = 0;
  resignAttempted = new Set();
  if (
    toggleCogEl.checked &&
    (!deckOverlay || !MosaicLayerClass || !COGLayerClass)
  ) {
    await initImagerySupport();
  }
  const allLoaded = !stateEl.value;
  const body = {
    collections: [activeCollection()],
    bbox: allLoaded ? bboxAtZoom(7) : currentBbox(),
    limit: Number(limitEl.value || SEARCH_LIMIT_DEFAULT),
  };
  if (stateEl.value) {
    body.region = stateEl.value;
  }
  if (yearEl.value) {
    body.year = Number(yearEl.value);
  }

  summaryEl.textContent = trigger === "auto" ? "Loading… (auto)" : "Loading…";
  timingSummaryEl.textContent = "Timing pending…";

  const searchPath = "/search";

  const fetchStartedAt = performance.now();
  try {
    const response = await apiFetch(searchPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const fetchMs = performance.now() - fetchStartedAt;

    if (searchToken < activeSearchToken) {
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      summaryEl.textContent = `Error: ${response.status} ${text}`;
      return;
    }

    const serverTimings = readTimingHeaders(response);
    const jsonStartedAt = performance.now();
    const data = await response.json();
    const jsonMs = performance.now() - jsonStartedAt;

    if (searchToken < activeSearchToken) {
      return;
    }

    const features = data.features || [];
    lastSearchFeatures = features;
    updateSearchResultsCount();
    if (selectedCollectionId) {
      renderCollectionDetail(selectedCollectionId);
    }
    lastSearchBbox = body.bbox;
    const _isLake = true;
    const engineName = "GeoParquet lake (DuckDB direct)";
    const engineExplain =
      "Footprints read from partitioned GeoParquet files via a standalone in-process DuckDB connection (read_parquet) — no database server. Prunes by bbox columns + row-group stats. This is the serverless lake read path.";
    const filterNote = [];
    if (body.region) {
      filterNote.push(`region = ${body.region}`);
    }
    if (body.year) {
      filterNote.push(`year = ${body.year}`);
    }
    const zeroHint =
      features.length === 0
        ? `<div class="muted" style="color:#fbbf24; margin-top:4px;">No footprints matched. Either this area isn't ingested, or a filter excludes it${filterNote.length ? ` (${filterNote.join(", ")})` : ""}. Try clearing the Region/Year filters.</div>`
        : "";
    summaryEl.innerHTML = `
      <strong>Found ${features.length} footprint${features.length === 1 ? "" : "s"} in the current map view.</strong>
      <div class="muted" style="margin-top:4px;">
        <strong>Read engine:</strong> ${engineName} &nbsp;<code>${searchPath}</code>
      </div>
      <div class="muted" style="line-height:1.4; margin-top:2px;">${engineExplain}</div>
      <div class="muted" style="margin-top:4px;">
        <strong>Server query time:</strong> ${serverTimings.sqlMs.toFixed(1)} ms to find the footprints${serverTimings.signMs > 0 ? ` + ${serverTimings.signMs.toFixed(1)} ms to sign image URLs` : ""} (server total ${serverTimings.totalMs.toFixed(1)} ms).
      </div>
      <div class="muted" style="margin-top:2px;">Map view bbox [W, S, E, N]: ${body.bbox.map((v) => v.toFixed(4)).join(", ")}${filterNote.length ? ` · filters: ${filterNote.join(", ")}` : " · no region/year filter"}</div>
      ${zeroHint}
    `;

    const resultsStartedAt = performance.now();
    renderResults(features);
    const resultsMs = performance.now() - resultsStartedAt;
    const footprintUpdate = updateMap(features);
    const imageryUpdate = updateImagery(features);
    updateImageryLayers();
    const timings = {
      trigger,
      bbox: body.bbox.map((value) => Number(value.toFixed(4))),
      server: {
        ...serverTimings,
      },
      client: {
        fetchMs,
        jsonMs,
        resultsMs,
        footprintsMs: footprintUpdate?.durationMs ?? 0,
        imageryMs: imageryUpdate?.durationMs ?? 0,
        totalMs: performance.now() - clientStartedAt,
      },
    };
    renderTimingSummary(timings);
    logTimingBreakdown(timings);
  } catch (error) {
    if (searchToken < activeSearchToken) {
      return;
    }
    console.error("Search fetch failed:", error);
    summaryEl.innerHTML = `
      <span style="color:#f87171; font-weight:bold;">Network Error calling STAC search API.</span>
      <div class="small muted" style="margin-top:4px;">${error?.message || error}</div>
      <div class="small muted" style="margin-top:4px; line-height:1.4;">Please make sure the Uvicorn FastAPI server container is running and accessible at <code>http://localhost:8089/</code>, and that you are accessing the viewer via <code>http://localhost:8089/viewer/</code> (avoiding <code>file://</code> URLs).</div>
    `;
    timingSummaryEl.textContent = "Timing unavailable due to error.";
  }
}

async function queueSearch(trigger = "manual") {
  if (searchInFlight) {
    pendingSearch = true;
    return;
  }

  searchInFlight = true;
  try {
    await runSearch(trigger);
  } finally {
    searchInFlight = false;
    if (pendingSearch) {
      pendingSearch = false;
      await queueSearch("auto");
    }
  }
}

// --- Dependent State -> Year dropdowns for the search panel ---------
// Availability comes from /availability for the selected read engine
// (postgis row store vs GeoParquet lake). Picking a state fills Year with
// that state's ingested years (newest first) and auto-selects the newest,
// so the viewer never issues the slow no-year (all-vintages) scan.
let searchAvailability = {};
let searchAvailabilityGsd = {}; // {region: {year: meters}} from /availability
let searchAvailabilityExtent = {}; // {region: {year: [xmin,ymin,xmax,ymax]}} from /availability

// Fly to the current Collection/Region/Year selection. Specific regions
// use a fixed zoom rather than fitBounds: fitting a large state's full
// extent would trigger an auto-search over the whole state and flood
// the footprint limit. "All loaded" is intentionally different: it fits
// the active collection's registered bbox, e.g. CONUS for NAIP and KY for
// KyFromAbove.
const _CENTER_ZOOM = Number(
  new URLSearchParams(location.search).get("centerZoom") ||
    window.S3_COG_CENTER_ZOOM ||
    11,
);
const CONUS_BBOX = [-125, 24, -66.5, 50];
const CONUS_CENTER_MAX_ZOOM = Number(
  new URLSearchParams(location.search).get("conusCenterMaxZoom") ||
    window.S3_COG_CONUS_CENTER_MAX_ZOOM ||
    4.8,
);

function isValidLngLatBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every((v) => Number.isFinite(Number(v))) &&
    Number(bbox[0]) < Number(bbox[2]) &&
    Number(bbox[1]) < Number(bbox[3])
  );
}

function fitLngLatBbox(bbox, extraOptions = {}) {
  if (!isValidLngLatBbox(bbox)) {
    return false;
  }
  const b = bbox.map(Number);
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    {
      padding: { top: 72, right: 48, bottom: 72, left: 48 },
      duration: 1200,
      ...extraOptions,
    },
  );
  return true;
}

function activeCollectionBbox() {
  const collection = collectionById[activeCollection()];
  return isValidLngLatBbox(collection?.bbox) ? collection.bbox : null;
}

function centerOnSelection() {
  const st = stateEl.value;
  if (!st) {
    if (!fitLngLatBbox(activeCollectionBbox())) {
      fitLngLatBbox(CONUS_BBOX, { maxZoom: CONUS_CENTER_MAX_ZOOM });
    }
    return;
  }
  const yr = yearEl.value;
  let box = null;
  const merge = (b) => {
    if (!b) {
      return;
    }
    box = box
      ? [
          Math.min(box[0], b[0]),
          Math.min(box[1], b[1]),
          Math.max(box[2], b[2]),
          Math.max(box[3], b[3]),
        ]
      : [...b];
  };
  for (const region of [st]) {
    const byYear = searchAvailabilityExtent[region] || {};
    if (yr) {
      merge(byYear[yr]);
    } else {
      Object.values(byYear).forEach(merge);
    }
  }
  if (box) {
    fitLngLatBbox(box);
  } else {
    // If no state extent is ingested yet, fall back to the active collection's bbox
    if (!fitLngLatBbox(activeCollectionBbox())) {
      fitLngLatBbox(CONUS_BBOX, { maxZoom: CONUS_CENTER_MAX_ZOOM });
    }
  }
}

function gsdLabel(meters) {
  if (!Number.isFinite(meters) || meters <= 0) {
    return null;
  }
  return meters >= 1 ? `${meters} m` : `${Math.round(meters * 100)} cm`;
}

// Resolution annotation for a year option. With a specific state, use that
// state's gsd; for "All loaded", show the finest gsd any state has for
// that year (matching the API's min() semantics).
function yearOptionLabel(year, st) {
  let g = null;
  if (st) {
    g = searchAvailabilityGsd[st]?.[String(year)];
  } else {
    for (const region of Object.keys(searchAvailabilityGsd)) {
      const v = searchAvailabilityGsd[region][String(year)];
      if (v != null && (g == null || v < g)) {
        g = v;
      }
    }
  }
  const label = gsdLabel(Number(g));
  return label ? `${year} — ${label}` : String(year);
}

function populateSearchYears() {
  const st = stateEl.value;
  yearEl.innerHTML = "";

  if (!st) {
    // "All loaded" — build the union of all ingested years for the
    // dropdown, but leave the selection on "Latest available" (no year
    // filter). The API sorts naip_year desc, so the freshest data per
    // state surfaces first without a year constraint. Forcing a single
    // year as default is jarring (visible dropdown jump at startup) and
    // wrong when states have different most-recent years.
    const allYears = Array.from(
      new Set([].concat(...Object.values(searchAvailability))),
    ).sort((a, b) => b - a);
    // "Latest available" option — no year filter, results sorted naip_year desc.
    const anyOpt = document.createElement("option");
    anyOpt.value = "";
    anyOpt.textContent = "Latest available";
    yearEl.appendChild(anyOpt);
    allYears.forEach((y) => {
      const o = document.createElement("option");
      o.value = y;
      o.textContent = yearOptionLabel(y, "");
      yearEl.appendChild(o);
    });
    // "All loaded" always uses Latest available (no year filter). If the
    // user comes from a specific region/year, do not carry that year into
    // a CONUS-level search.
    yearEl.value = "";
  } else {
    // Specific state: list that state's ingested years newest-first and
    // auto-select the most recent. No "Any" option -- the no-year path
    // scans the whole state's partitions and is meaningfully slower.
    const years = searchAvailability[st] || [];
    years.forEach((y) => {
      const o = document.createElement("option");
      o.value = y;
      o.textContent = yearOptionLabel(y, st);
      yearEl.appendChild(o);
    });
    if (!years.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "Any";
      yearEl.appendChild(o);
    }
    yearEl.value = years.length ? String(years[0]) : "";
  }
}

// Populate the set of collections actually present in the lake
// (/collections). The "Collections in View" rows are the selector.
//
// Resilience: /collections lists the lake's collection= partitions, which
// needs AWS credentials. A transient failure (e.g. flapping/expired creds)
// must NOT demote already-ingested collections to "not ingested". So on
// failure we keep the last-known searchable set and retry with backoff,
// and a recovered retry re-renders the panel. Returns true on success.
let collectionsRetryTimer = null;
async function refreshCollections({ retry = true } = {}) {
  let ok = false;
  try {
    const response = await apiFetch(`/collections`);
    if (!response.ok) {
      throw new Error(`/collections HTTP ${response.status}`);
    }
    const data = await response.json();
    const ids = (data.collections || []).map((c) => c.id);
    if (!ids.length) {
      ids.push("naip");
    }
    searchableCollectionIds = new Set(ids);
    const prev = activeSearchCollectionId;
    activeSearchCollectionId = ids.includes(prev)
      ? prev
      : ids.includes("naip")
        ? "naip"
        : ids[0];
    if (!selectedCollectionId || !collectionById[selectedCollectionId]) {
      selectedCollectionId = activeSearchCollectionId;
    }
    renderActiveCollectionSummary();
    updateCollectionsHere();
    ok = true;
  } catch (error) {
    // Keep the previous (good) searchableCollectionIds rather than
    // clobbering it -- a transient failure shouldn't hide collections.
    console.error(
      "collections fetch failed (keeping last-known collections):",
      error,
    );
  }
  if (!ok && retry) {
    scheduleCollectionsRetry();
  }
  return ok;
}

// Re-poll /collections after a failure until it succeeds (bounded), so a
// bad-creds moment at load self-heals once the lake is readable again.
function scheduleCollectionsRetry() {
  if (collectionsRetryTimer !== null) {
    return;
  }
  let attempt = 0;
  const tick = async () => {
    attempt += 1;
    const ok = await refreshCollections({ retry: false });
    if (ok || attempt >= 5) {
      collectionsRetryTimer = null;
      return;
    }
    collectionsRetryTimer = window.setTimeout(
      tick,
      Math.min(15000, 2000 * attempt),
    );
  };
  collectionsRetryTimer = window.setTimeout(tick, 2000);
}

async function refreshAvailability() {
  const prevState = stateEl.value;
  try {
    const response = await apiFetch(
      `/availability?collection=${encodeURIComponent(activeCollection())}`,
    );
    if (!response.ok) {
      let detail = `${response.status}`;
      try {
        const payload = await response.json();
        detail += payload?.detail ? ` ${payload.detail}` : "";
      } catch (_) {
        try {
          detail += ` ${await response.text()}`;
        } catch (_) {
          /* ignore */
        }
      }
      throw new Error(detail);
    }
    const data = await response.json();
    searchAvailability = data?.states || {};
    searchAvailabilityGsd = data?.gsd || {};
    searchAvailabilityExtent = data?.extent || {};
    const states = Object.keys(searchAvailability);
    stateEl.innerHTML = '<option value="">All loaded</option>';
    states.forEach((st) => {
      const o = document.createElement("option");
      o.value = st;
      o.textContent = `${st.toUpperCase()} (${(searchAvailability[st] || []).join(", ")})`;
      stateEl.appendChild(o);
    });
    // Preserve the prior selection if still valid; else stay on "All loaded".
    if (prevState && searchAvailability[prevState]) {
      stateEl.value = prevState;
    } else {
      stateEl.value = "";
    }
    populateSearchYears();
    return true;
  } catch (error) {
    console.error("availability fetch failed:", error);
    searchAvailability = {};
    searchAvailabilityGsd = {};
    searchAvailabilityExtent = {};
    stateEl.innerHTML = '<option value="">Availability failed</option>';
    yearEl.innerHTML = '<option value="">Unavailable</option>';
    summaryEl.innerHTML = `
      <span style="color:#f87171; font-weight:bold;">Availability failed for ${activeCollection()}.</span>
      <div class="small muted" style="margin-top:4px;">${error?.message || error}</div>
    `;
    return false;
  }
}

stateEl.addEventListener("change", () => {
  populateSearchYears();
  queueSearch("auto");
  updateNaipCoverageMvtLayer();
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
});
yearEl.addEventListener("change", () => {
  queueSearch("auto");
  updateNaipCoverageMvtLayer();
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
});
document
  .getElementById("center-data")
  .addEventListener("click", centerOnSelection);

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});
refreshEnvironmentBtn.addEventListener("click", refreshEnvironment);
runIngestBtn.addEventListener("click", runIngest);

// Show the token field on deployed viewers (no baked-in token). Local dev keeps
// its config.js fallback, and a local API with no token configured skips auth
// entirely, so there is nothing to paste there.
if (ingestTokenFieldEl && !window.S3_COG_INGEST_TOKEN) {
  ingestTokenFieldEl.style.display = "flex";
}
if (ingestTokenEl) {
  ingestTokenEl.value = storedIngestToken();
  ingestTokenEl.addEventListener("input", () => {
    const value = ingestTokenEl.value.trim();
    ingestTokenMemory = value;
    try {
      if (value) {
        sessionStorage.setItem(INGEST_TOKEN_STORAGE_KEY, value);
      } else {
        sessionStorage.removeItem(INGEST_TOKEN_STORAGE_KEY);
      }
    } catch {
      // Storage blocked; ingestTokenMemory still authorizes this page load, the
      // value just will not survive a reload.
    }
  });
}

let ingestMode = "catalog"; // or "custom"
let ingestCatalogMetadata = null;
let currentAccountId = "";
let currentBucketName = "";

window.toggleCredentialsSection = () => {
  const el = document.getElementById("ingest-creds-container");
  const icon = document.getElementById("creds-toggle-icon");
  if (el.style.display === "none") {
    el.style.display = "block";
    icon.textContent = "▲";
  } else {
    el.style.display = "none";
    icon.textContent = "▼";
  }
};

window.togglePolicySection = () => {
  const el = document.getElementById("ingest-policy-helper");
  const icon = document.getElementById("policy-toggle-icon");
  if (el.style.display === "none") {
    el.style.display = "block";
    icon.textContent = "▼";
  } else {
    el.style.display = "none";
    icon.textContent = "▶";
  }
};

function updateIamPolicyHelper() {
  const _acc = currentAccountId || "<your-aws-account-id>";
  const buck = currentBucketName || "deckgl-s3-cog-s1m-<account>-us-west2";
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ],
        Resource: [`arn:aws:s3:::${buck}`, `arn:aws:s3:::${buck}/*`],
      },
    ],
  };
  document.getElementById("policy-pre").textContent = JSON.stringify(
    policy,
    null,
    2,
  );
}

function switchIngestMode(mode) {
  ingestMode = mode;
  if (mode === "catalog") {
    ingestModeCatalogBtn.classList.add("active");
    ingestModeCustomBtn.classList.remove("active");
    ingestCatalogFieldsWrap.style.display = "block";
    ingestCustomFieldsWrap.style.display = "none";
    loadIngestCatalogOptions();
  } else {
    ingestModeCatalogBtn.classList.remove("active");
    ingestModeCustomBtn.classList.add("active");
    ingestCatalogFieldsWrap.style.display = "none";
    ingestCustomFieldsWrap.style.display = "block";
  }
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
}

async function loadIngestCatalogOptions() {
  try {
    const selectedCol = ingestCatalogCollectionEl.value || "";
    const response = await apiFetch("/ingest/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collection: selectedCol,
      }),
    });
    if (!response.ok) {
      console.error("Failed to load ingest options", response.status);
      return;
    }
    const data = await response.json();
    ingestCatalogMetadata = data;
    currentAccountId = data.account_id || "";
    currentBucketName = data.bucket_name || "";
    updateIamPolicyHelper();

    // Populate Collections dropdown if not already set or updated
    const currentCollectionVal = ingestCatalogCollectionEl.value;
    ingestCatalogCollectionEl.innerHTML = "";
    data.collections.forEach((colId) => {
      const opt = document.createElement("option");
      opt.value = colId;
      opt.textContent = colId.toUpperCase();
      if (
        colId === currentCollectionVal ||
        (!currentCollectionVal && colId === "naip")
      ) {
        opt.selected = true;
      }
      ingestCatalogCollectionEl.appendChild(opt);
    });

    // Refresh states/regions and years dropdown lists
    updateCatalogRegionAndYearDropdowns();

    // Populate Strategies
    ingestCatalogStrategyEl.innerHTML = "";
    data.strategies.forEach((strat) => {
      const opt = document.createElement("option");
      opt.value = strat.id;
      opt.textContent = strat.label;
      ingestCatalogStrategyEl.appendChild(opt);
    });
  } catch (err) {
    console.error("Error loading ingest options:", err);
  }
}

function updateCatalogRegionAndYearDropdowns() {
  if (!ingestCatalogMetadata) {
    return;
  }
  const currentRegionVal = ingestCatalogRegionEl.value;
  ingestCatalogRegionEl.innerHTML = "";

  ingestCatalogMetadata.states.forEach((st) => {
    const opt = document.createElement("option");
    opt.value = st.state;
    const ingested = searchAvailability[st.state] || [];
    const suffix = ingested.length ? ` (${ingested.join(", ")})` : "";
    opt.textContent = `${st.state.toUpperCase()}${suffix}`;
    if (st.state === currentRegionVal) {
      opt.selected = true;
    }
    ingestCatalogRegionEl.appendChild(opt);
  });

  updateCatalogYearDropdown();
}

function updateCatalogYearDropdown() {
  if (!ingestCatalogMetadata) {
    return;
  }
  const selectedRegion = ingestCatalogRegionEl.value;
  const stateObj = ingestCatalogMetadata.states.find(
    (st) => st.state === selectedRegion,
  );

  const currentYearVal = ingestCatalogYearEl.value;
  ingestCatalogYearEl.innerHTML = "";

  if (stateObj?.years) {
    stateObj.years.forEach((yr) => {
      const opt = document.createElement("option");
      opt.value = yr;
      const ingested = searchAvailability[selectedRegion] || [];
      const isIngested = ingested.includes(yr);
      opt.textContent = isIngested ? `${yr} (already ingested)` : String(yr);
      if (String(yr) === String(currentYearVal)) {
        opt.selected = true;
      }
      ingestCatalogYearEl.appendChild(opt);
    });
  }
}

ingestModeCatalogBtn.addEventListener("click", () =>
  switchIngestMode("catalog"),
);
ingestModeCustomBtn.addEventListener("click", () => switchIngestMode("custom"));
ingestCatalogCollectionEl.addEventListener("change", () => {
  loadIngestCatalogOptions();
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
});
ingestCatalogRegionEl.addEventListener("change", () => {
  updateCatalogYearDropdown();
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
});
ingestCatalogYearEl.addEventListener("change", () => {
  if (selectedCollectionId) {
    renderCollectionDetail(selectedCollectionId);
  }
});

// --- Terrain (S1M DEM -> 3D mesh, viewport-tiled) ---
const terExagEl = document.getElementById("ter-exag");
const terExagValEl = document.getElementById("ter-exag-val");
if (terExagEl) {
  terExagEl.addEventListener("input", () => {
    terExagValEl.textContent = `${Number(terExagEl.value).toFixed(1)}×`;
    rebuildS1MLayers(); // live exaggeration: rebuild cached tiles, no refetch
    if (terBuildingsEl?.checked && buildingFeatureData) {
      applyBuildingExtrusionZ(); // keep bases on the relief
    }
  });
}
function normalizeS1MSurfaceControls(changed) {
  const surfaceEl = document.getElementById("ter-surface");
  const modeEl = document.getElementById("ter-mode");
  const gpuEl = document.getElementById("ter-gpu");
  if (surfaceEl?.value === "imagery") {
    if (modeEl) {
      modeEl.value = "shaded";
    }
    if (gpuEl) {
      gpuEl.checked = true;
      gpuEl.disabled = true;
    }
  } else {
    if (gpuEl) {
      gpuEl.disabled = false;
    }
    if (changed === "mode" && modeEl?.value === "wireframe" && surfaceEl) {
      surfaceEl.value = "shaded";
    }
  }
}
// Switching GPU<->CPU rebuilds the same cached grids with the other layer type.
document.getElementById("ter-gpu")?.addEventListener("change", () => {
  normalizeS1MSurfaceControls("gpu");
  rebuildS1MLayers();
});
document.getElementById("ter-surface")?.addEventListener("change", () => {
  normalizeS1MSurfaceControls("surface");
  if (s1mActive) {
    refreshS1MTerrain();
  } else {
    rebuildS1MLayers();
  }
});
document.getElementById("ter-mode")?.addEventListener("change", () => {
  normalizeS1MSurfaceControls("mode");
  rebuildS1MLayers();
}); // shaded <-> wireframe
document.getElementById("ter-color")?.addEventListener("change", () => {
  rebuildS1MLayers(); // adaptive <-> absolute changes the displacement baseline (zmin)
  if (terBuildingsEl?.checked && buildingFeatureData) {
    applyBuildingExtrusionZ();
  }
});

document
  .getElementById("ter-buildings")
  ?.addEventListener("change", refreshBuildingFootprints);
document.getElementById("ter-run")?.addEventListener("click", enableS1MTerrain);
document
  .getElementById("ter-clear")
  ?.addEventListener("click", clearS1MTerrain);
document
  .getElementById("ter-stats-window")
  ?.addEventListener("click", s1mOpenStatsWindow);
toggleS1MFootprintsLayerEl?.addEventListener("change", async () => {
  if (toggleS1MFootprintsLayerEl.checked) {
    await initImagerySupport();
  }
  refreshS1MFootprintsLayer();
});
toggleNaipSearchFootprintsLayerEl?.addEventListener(
  "change",
  updateNaipSearchFootprintsVisibility,
);
toggleNaipCoverageMvtLayerEl?.addEventListener(
  "change",
  updateNaipCoverageMvtLayer,
);
footprintLayerModeEls.forEach((el) => {
  el.addEventListener("change", syncFootprintLayerMode);
});

toggleCogEl.addEventListener("change", () => {
  updateImagery(lastSearchFeatures);
  if (toggleCogEl.checked) {
    queueSearch("auto");
  }
});

toggleUsgsNaipWmsLayerEl.addEventListener("change", () => {
  updateReferenceRasterLayers();
});

let displayAdjustmentFrame = null;
function updateDisplayAdjustmentLabels() {
  const brightness = Number(brightnessEl.value);
  brightnessValueEl.textContent = `${brightness > 0 ? "+" : ""}${brightness}%`;
  contrastValueEl.textContent = `${Number(contrastEl.value)}%`;
}
function scheduleDisplayAdjustmentRender() {
  updateDisplayAdjustmentLabels();
  displayAdjustmentProps.brightness = Number(brightnessEl.value) / 100;
  displayAdjustmentProps.contrast = Number(contrastEl.value) / 100;
  if (displayAdjustmentFrame !== null) {
    cancelAnimationFrame(displayAdjustmentFrame);
  }
  displayAdjustmentFrame = requestAnimationFrame(() => {
    displayAdjustmentFrame = null;
    imageryRevision += 1;
    clearS1MDrapeImages();
    map.triggerRepaint();
    deckOverlay?._deck?.redraw("display adjustments");
    if (s1mActive && drapeImageryActive()) {
      refreshS1MTerrain();
    }
  });
}
brightnessEl.addEventListener("input", scheduleDisplayAdjustmentRender);
contrastEl.addEventListener("input", scheduleDisplayAdjustmentRender);
resetDisplayEl.addEventListener("click", () => {
  brightnessEl.value = "0";
  contrastEl.value = "100";
  scheduleDisplayAdjustmentRender();
});
updateDisplayAdjustmentLabels();

map.on("movestart", () => {
  if (toggleCogEl.checked) {
    imageryStatusEl.textContent =
      "Keeping current imagery while map view changes.";
    imageryStatusEl.className = "small status-ok";
  }
});
map.on("move", () => {
  updateLayerNumberControl();
});

// --- Collections registry (layer 0): which collections cover the viewport ---
// Compiled from collections/registry.yaml by build_collections_geojson.py.
// SEARCHABLE = collections actually present in the lake -> exactly the
// rows that can become the active COG Footprints collection.
const isSearchableCollection = (id) => searchableCollectionIds.has(id);
let collectionFeatures = [];
let collectionById = {};
let selectedCollectionId = null;

async function loadCollectionsRegistry() {
  try {
    const res = await fetch("./collections.geojson", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const fc = await res.json();
    collectionFeatures = (fc.features || []).map((f) => f.properties);
    collectionById = Object.fromEntries(
      collectionFeatures.map((p) => [p.id, p]),
    );
  } catch (err) {
    console.warn("collections.geojson load failed", err);
    collectionFeatures = [];
    collectionById = {};
  }
}
function collectionAvailability(p) {
  if (!p.active) {
    return {
      label: `available · ${p.bucket_region} · region-deferred`,
      cls: "muted",
    };
  }
  if (isSearchableCollection(p.id)) {
    return { label: "ingested · searchable", cls: "status-ok" };
  }
  return { label: "registered · not yet ingested", cls: "status-warn" };
}
function updateCollectionsHere() {
  const el = document.getElementById("collections-here");
  if (!el) {
    return;
  }
  if (!collectionFeatures.length) {
    el.textContent = "Collection registry unavailable.";
    el.className = "small muted";
    return;
  }
  const hits = [...collectionFeatures].sort((a, x) =>
    a.active === x.active ? 0 : a.active ? -1 : 1,
  );
  el.className = "small";
  el.innerHTML = hits
    .map((p) => {
      const yrs =
        Array.isArray(p.years) && p.years.length === 2
          ? ` <span class="muted">${p.years[0]}–${p.years[1]}</span>`
          : "";
      const dot = p.active ? "#22c55e" : "#9ca3af";
      const selected =
        p.id === selectedCollectionId
          ? "background:rgba(59,130,246,.18);border:1px solid #3b82f6;"
          : "border:1px solid transparent;";
      const dim = p.active ? "" : "opacity:.6;";
      const name = p.active
        ? `<strong>${p.title}</strong>${yrs}`
        : `${p.title}`;
      return (
        `<div class="collection-row" data-cid="${p.id}" tabindex="0" role="button"` +
        ` style="display:flex;align-items:center;gap:6px;margin:2px 0;padding:2px 4px;` +
        `border-radius:4px;cursor:pointer;${selected}${dim}">` +
        `<span class="swatch" style="background:${dot}"></span>${name}</div>`
      );
    })
    .join("");
  if (selectedCollectionId && collectionById[selectedCollectionId]) {
    renderCollectionDetail(selectedCollectionId);
  }
}
async function selectCollection(id) {
  if (!collectionById[id]) {
    return;
  }
  selectedCollectionId = id;
  // If the registry marks this collection active (ingestable) but it isn't
  // currently in the searchable set, the lake listing may have failed
  // transiently (e.g. flapping creds) at load. Re-check /collections now so
  // a user click recovers immediately once the lake is readable, instead of
  // showing a stale "not yet ingested".
  if (collectionById[id].active && !isSearchableCollection(id)) {
    await refreshCollections({ retry: false });
  }
  updateCollectionsHere();
  renderCollectionDetail(id);
  // Tie layer 0 -> layer 1: if this collection is actually searchable
  // (present in the lake), make it the active search collection.
  if (isSearchableCollection(id)) {
    const changed = activeSearchCollectionId !== id;
    activeSearchCollectionId = id;
    updateCogLayerLabel();
    renderActiveCollectionSummary();
    if (changed) {
      releaseS1MDrapeMemory();
    }
    refreshAvailability().then((ok) => {
      if (changed && s1mActive) {
        refreshS1MTerrain();
      }
      if (ok && changed) {
        queueSearch("auto");
      }
      updateNaipCoverageMvtLayer();
    });
  }
}
function resolveTemplate(template, feature) {
  if (!feature?.id) {
    return template;
  }

  const isIngestTab = document
    .getElementById("tab-ingest")
    ?.classList.contains("active");
  let activeState = stateEl.value;
  let activeYear = yearEl.value;
  if (isIngestTab) {
    activeState = document.getElementById("ingest-catalog-region")?.value || "";
    activeYear = document.getElementById("ingest-catalog-year")?.value || "";
  }
  const stateCode = activeState ? activeState.split("-")[0] : "";

  const idx = feature.id.indexOf("/");
  if (idx === -1) {
    return template;
  }
  const key = feature.id.substring(idx + 1);
  const templateParts = template.split("/");
  const keyParts = key.split("/");
  const resultParts = [];
  for (let i = 0; i < templateParts.length; i++) {
    const tPart = templateParts[i];
    if (tPart.startsWith("{") && tPart.endsWith("}")) {
      const varName = tPart.slice(1, -1);
      if (varName === "state" && !stateCode) {
        resultParts.push("[state]");
      } else if (varName === "year" && !activeYear) {
        resultParts.push("[year]");
      } else if (varName === "resolution" && !activeYear) {
        resultParts.push("[resolution]");
      } else if (i < keyParts.length) {
        resultParts.push(keyParts[i]);
      } else {
        resultParts.push(tPart);
      }
    } else {
      resultParts.push(tPart);
    }
  }
  return resultParts.join("/");
}

function renderCollectionDetail(id) {
  const el = document.getElementById("collection-detail");
  if (!el) {
    return;
  }
  const p = id && collectionById[id];
  if (!p) {
    el.innerHTML = "";
    return;
  }
  const avail = collectionAvailability(p);
  const badgeCls =
    avail.cls === "status-ok"
      ? "ok"
      : avail.cls === "status-warn"
        ? "warn"
        : "neutral";
  const yrs =
    Array.isArray(p.years) && p.years.length === 2
      ? `${p.years[0]}–${p.years[1]}`
      : "—";

  let prefixPath = p.root_prefix || "—";
  const firstFeature =
    Array.isArray(lastSearchFeatures) && lastSearchFeatures[0];
  if (firstFeature && prefixPath.includes("{")) {
    prefixPath = resolveTemplate(prefixPath, firstFeature);
  } else if (prefixPath.includes("{")) {
    const isIngestTab = document
      .getElementById("tab-ingest")
      ?.classList.contains("active");
    let st = stateEl.value || "[state]";
    let yr = yearEl.value || "[year]";
    let optText = yearEl.options[yearEl.selectedIndex]?.textContent || "";

    if (isIngestTab) {
      const ingReg = document.getElementById("ingest-catalog-region")?.value;
      const ingYr = document.getElementById("ingest-catalog-year")?.value;
      if (ingReg) {
        st = ingReg;
      }
      if (ingYr) {
        yr = ingYr;
        const ingYrEl = document.getElementById("ingest-catalog-year");
        optText = ingYrEl?.options[ingYrEl.selectedIndex]?.textContent || "";
      }
    }

    const stCode = st ? st.split("-")[0] : "[state]";

    let res = "[resolution]";
    if (stCode && yr && searchAvailabilityGsd[stCode]) {
      const gsd = searchAvailabilityGsd[stCode][String(yr)];
      if (gsd) {
        const label = gsdLabel(Number(gsd));
        if (label) {
          res = label.replace(/\s+/g, ""); // e.g. "60cm"
        }
      }
    }
    if (res === "[resolution]" && optText) {
      const match = optText.match(/(\d+)\s*(cm|m)/i);
      if (match) {
        res = match[1] + match[2].toLowerCase();
      }
    }

    prefixPath = prefixPath
      .replace(/{state}/g, stCode)
      .replace(/{year}/g, yr)
      .replace(/{resolution}/g, res)
      .replace(/{zone}/g, "[zone]")
      .replace(/{phase}/g, "[phase]");
  }

  const rows = [
    [
      "bucket",
      `${p.bucket} <span class="muted">(${p.bucket_region}, ${p.access})</span>`,
    ],
    ["prefix path", `${prefixPath}`],
    ["region", `${p.region_code || p.region_kind || "—"}`],
    ["years", yrs],
    ["COG verified", p.cog_verified ? "yes" : "—"],
  ];
  if (p.display?.sample_bits) {
    rows.push(["sample depth", `${p.display.sample_bits}-bit`]);
  }
  if (Array.isArray(p.display?.domain) && p.display.domain.length === 2) {
    rows.push(["value range", `${p.display.domain[0]}–${p.display.domain[1]}`]);
  }
  const canSearch = p.active && isSearchableCollection(p.id);
  const hint = canSearch
    ? `<div class="small status-ok" style="margin-top:6px;">Selected for search — use Footprints filters below.</div>`
    : p.active
      ? `<div class="small status-warn" style="margin-top:6px;">Not in the lake yet — ingest needed before it can be searched.</div>`
      : `<div class="small muted" style="margin-top:6px;">Outside the current us-west-2 scope.</div>`;
  el.innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">` +
    `<span style="font-weight:600;">${p.title}</span>` +
    `<span class="cd-badge ${badgeCls}">${avail.label}</span>` +
    `</div>` +
    `<div class="cd-kv">` +
    rows
      .map(([k, v]) => `<span class="cd-key">${k}</span><span>${v}</span>`)
      .join("") +
    `</div>` +
    hint;
}

map.on("moveend", () => {
  updateLayerNumberControl();
  updateCollectionsHere();
  refreshS1MFootprintsLayer();
  updateNaipCoverageMvtLayer();
  if (!mapReady) {
    return;
  }
  if (autoSearchTimeoutId !== null) {
    window.clearTimeout(autoSearchTimeoutId);
  }
  autoSearchTimeoutId = window.setTimeout(() => {
    autoSearchTimeoutId = null;
    // Skip the search if existing footprints already cover the viewport
    if (footprintsCoverViewport(lastSearchFeatures)) {
      imageryStatusEl.textContent =
        "Footprints cover viewport — search skipped.";
      imageryStatusEl.className = "small status-ok";
      updateResolutionDebug(lastSearchFeatures, getImagerySources());
      // Still refresh deck.gl layers so panning picks up the new
      // viewport position with existing features.
      updateImageryLayers();
    } else {
      queueSearch("auto");
    }
  }, 250);
});
map.on("load", async () => {
  map.showTileBoundaries = false;

  updateLayerNumberControl();
  await loadCollectionsRegistry();
  const collectionsHereEl = document.getElementById("collections-here");
  if (collectionsHereEl) {
    // Delegated: rows are re-rendered on each moveend, listener persists on parent.
    const onPick = (ev) => {
      const row = ev.target.closest(".collection-row");
      if (row?.dataset.cid) {
        selectCollection(row.dataset.cid);
      }
    };
    collectionsHereEl.addEventListener("click", onPick);
    collectionsHereEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onPick(ev);
      }
    });
  }
  updateCollectionsHere();
  map.addSource("usgs-naip-wms", {
    type: "raster",
    tiles: [
      "https://basemap.nationalmap.gov/arcgis/services/USGSImageryOnly/MapServer/WMSServer?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=0&STYLES=&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}",
    ],
    tileSize: 256,
    maxzoom: 22,
  });

  map.addLayer({
    id: "usgs-naip-wms-layer",
    type: "raster",
    source: "usgs-naip-wms",
    paint: {
      "raster-opacity": 1.0,
    },
    layout: {
      visibility: "none",
    },
  });
  updateReferenceRasterLayers();

  await initImagerySupport();
  refreshS1MFootprintsLayer();
  updateNaipCoverageMvtLayer();
  await refreshEnvironment();
  updateImageryLayers();
  await refreshCollections();
  updateCogLayerLabel();
  const availabilityOk = await refreshAvailability();
  if (availabilityOk) {
    await queueSearch("auto");
  }
  mapReady = true;
});

// Lambda Cold Start Notice Handling
const lambdaModal = document.getElementById("lambda-modal");

// The cold-start modal is disabled, not removed. Keep the name as `openModal`:
// the commented-out setTimeout below is the documented way to switch it back on,
// so renaming it (e.g. to _openModal) would quietly break that.
// biome-ignore lint/correctness/noUnusedVariables: intentionally retained, re-enabled via the setTimeout below
function openModal() {
  lambdaModal.classList.add("show");
}
function closeModal() {
  lambdaModal.classList.remove("show");
}

// Cold-start modal disabled for now (kept available via openModal()).
// setTimeout(openModal, 1000);

lambdaModal.addEventListener("click", () => {
  closeModal();
});
