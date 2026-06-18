import os
import json
import configparser
import subprocess
import sys
import time
from datetime import datetime

# Clean up empty AWS environment variables to prevent boto3 ProfileNotFound errors
for var in ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]:
    if var in os.environ and not os.environ[var].strip():
        del os.environ[var]

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from threading import Lock
from threading import Thread
from time import monotonic
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from uuid import uuid4

from pydantic import BaseModel
import boto3
from botocore.exceptions import BotoCoreError, CredentialRetrievalError, ClientError
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

COLLECTION_ID = os.environ.get("S3_COG_COLLECTION_ID", "naip")
# Root of the GeoParquet lake (written by ingest_duckdb.py). Every read path
# (/search, /availability) queries this tree directly with an in-process DuckDB
# connection -- there is no database server. The api container mounts ./cache at
# /cache, so this resolves to local Parquet files (or an s3:// prefix on Lambda).
LAKE_ROOT = os.environ.get("S3_COG_LAKE_ROOT", "/cache/exports/naip_rgbir_duckdb")
# Root of the embedding lake (written by the embedding-harvester repo). Same
# hive layout as the imagery lake (collection=/region=/year=), one file per
# 1-degree block, schema per that repo's LAKE_SCHEMA.md. /similar queries it
# with the same in-process DuckDB connection.
EMBED_LAKE_ROOT = os.environ.get("S3_COG_EMBED_LAKE_ROOT", "s3://naip-stac-catalog/embeddings")
EMBED_COLLECTION_ID = os.environ.get("S3_COG_EMBED_COLLECTION_ID", "clay-naip-v15")
# Embedding dimension of the default collection (Clay v1.5 = 1024). Parquet
# stores the vector as a list; queries cast to FLOAT[EMBED_DIM] for
# array_cosine_similarity.
EMBED_DIM = int(os.environ.get("S3_COG_EMBED_DIM", "1024"))
# On Lambda (AWS_LAMBDA_FUNCTION_NAME is set by the runtime) the only viable
# ingest is the synchronous in-process path; locally/Docker the async
# thread+subprocess path with polling is fine. S3_COG_INGEST_MODE overrides this:
# the read-only zip Lambda sets it to "disabled" because its trimmed package
# omits pyarrow/pyproj/pillow, so /ingest/* would ImportError. (A future
# container-image ingest function would set it back to "sync".)
INGEST_MODE = os.environ.get("S3_COG_INGEST_MODE") or (
    "sync" if os.environ.get("AWS_LAMBDA_FUNCTION_NAME") else "async"
)
# Base URL of the dedicated container-image ingest function (cog-stac-ingest).
# The read-only zip Lambda has INGEST_MODE=disabled but sets this so the viewer
# can POST ingest cross-origin to the container function instead. Empty locally
# (ingest runs in-process) and on the ingest function itself.
INGEST_URL = (os.environ.get("S3_COG_INGEST_URL") or "").rstrip("/")
MODULE_DIR = Path(__file__).resolve().parent
VIEWER_DIR = MODULE_DIR / "viewer"
if not VIEWER_DIR.exists():
    VIEWER_DIR = MODULE_DIR.parent / "viewer"
DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[2] if len(Path(__file__).resolve().parents) > 2 else Path(__file__).resolve().parent
REPO_ROOT = Path(os.environ.get("S3_COG_REPO_ROOT", DEFAULT_REPO_ROOT))
LOCAL_MODULE_DIRS = {
    "deck.gl-geotiff": REPO_ROOT / "packages" / "deck.gl-geotiff" / "dist",
    "geotiff": REPO_ROOT / "packages" / "geotiff" / "dist",
    "deck.gl-raster": REPO_ROOT / "packages" / "deck.gl-raster" / "dist",
    "affine": REPO_ROOT / "packages" / "affine" / "dist",
    "proj": REPO_ROOT / "packages" / "proj" / "dist",
    "morecantile": REPO_ROOT / "packages" / "morecantile" / "dist",
    "raster-reproject": REPO_ROOT / "packages" / "raster-reproject" / "dist",
}
SIGN_ASSET_URLS = os.environ.get("S3_COG_SIGN_ASSET_URLS", "1") not in {"0", "false", "False"}
# Decouple footprints from imagery: by default /search returns raw s3:// hrefs
# (fast, small payload, no batch signing up front) and the viewer signs each COG
# lazily via GET /sign as deck.gl actually loads it -- so footprints draw the
# moment the scan returns, and only on-screen tiles get signed. Set to "1" to
# restore the old behavior (sign every asset inline in the /search response).
SEARCH_SIGN_ASSETS = os.environ.get("S3_COG_SEARCH_SIGN_ASSETS", "0") not in {"0", "false", "False"}
PRESIGN_EXPIRES = int(os.environ.get("S3_COG_PRESIGN_EXPIRES", "3600"))
PRESIGN_CACHE_TTL = max(0, int(os.environ.get("S3_COG_PRESIGN_CACHE_TTL", str(min(max(PRESIGN_EXPIRES - 60, 0), 900)))))
PRESIGN_CACHE_MAXSIZE = max(1, int(os.environ.get("S3_COG_PRESIGN_CACHE_MAXSIZE", "10000")))
PRESIGN_MAX_WORKERS = max(1, int(os.environ.get("S3_COG_PRESIGN_MAX_WORKERS", "8")))
REQUEST_PAYER = os.environ.get("S3_COG_REQUEST_PAYER", "requester")
EARTHSEARCH_API = os.environ.get("S3_COG_EARTHSEARCH_API", "https://earth-search.aws.element84.com/v1/search")
EARTHSEARCH_PAGE_SIZE = int(os.environ.get("S3_COG_EARTHSEARCH_PAGE_SIZE", "500"))
# The partitioned Parquet manifest index (local path or s3://). Ingest reads it
# to select assets; the /environment probe confirms it is reachable.
MANIFEST_INDEX = os.environ.get("S3_COG_MANIFEST_INDEX", "/cache/manifest_index")
# The published flat NAIP manifest (requester-pays). The index is derived from
# it, so comparing its LastModified to the newest index object tells us whether
# AWS has republished the manifest (new COGs) since the index was last built.
MANIFEST_SOURCE = os.environ.get("S3_COG_MANIFEST_SOURCE", "s3://naip-analytic/manifest.txt")
# The single ingest path: reads the manifest index and writes GeoParquet to
# LAKE_ROOT (no Postgres, no staging table).
INGEST_SCRIPT_PATH = Path(__file__).parent / "ingest_duckdb.py"
# Local synchronous SAM 3 adapter. The raster-reading API and SAM 3 intentionally
# use separate Python environments because their NumPy requirements conflict.
SAM3_PYTHON = os.environ.get("SAM3_PYTHON", "")
SAM3_SCRIPT = os.environ.get("SAM3_SCRIPT", "")
SAM3_TIMEOUT_SECONDS = max(1, int(os.environ.get("SAM3_TIMEOUT_SECONDS", "300")))
# Optional warm-worker URL (dev/serve_sam3.py in sam-concept-worker). When set,
# /detect POSTs chips to the already-loaded model instead of spawning a cold
# subprocess per call -- the model load is paid once, not on every request. When
# unset, /detect falls back to the SAM3_PYTHON/SAM3_SCRIPT subprocess path.
SAM3_WORKER_URL = os.environ.get("SAM3_WORKER_URL", "").rstrip("/")
# Tiling (warm-worker only). A large chip_m is covered by a grid of native
# 1008px tiles instead of one decimated read. DEFAULT_TILE_OVERLAP_PX (~12.5%)
# lets seam-straddling objects land whole in a neighbor; MAX_TILES caps the
# grid so a runaway area can't fan out into hundreds of inferences.
TILE_PX = 1008
DEFAULT_TILE_OVERLAP_PX = max(0, int(os.environ.get("DEFAULT_TILE_OVERLAP_PX", "126")))
MAX_TILES = max(1, int(os.environ.get("MAX_TILES", "36")))

STATE_BBOXES = {
    "al": [-88.473227, 30.223334, -84.88908, 35.008028],
    "ar": [-94.617919, 33.004106, -89.644395, 36.4996],
    "az": [-114.81651, 31.332177, -109.045223, 37.00426],
    "ca": [-124.409591, 32.534156, -114.131211, 42.009518],
    "co": [-109.060253, 36.992426, -102.041522, 41.003444],
    "ct": [-73.727775, 40.980144, -71.786994, 42.050587],
    "de": [-75.788658, 38.451013, -75.048939, 39.839007],
    "fl": [-87.634938, 24.396308, -80.031362, 31.000888],
    "ga": [-85.605165, 30.357851, -80.839729, 35.000659],
    "hi": [-178.334698, 18.910361, -154.806773, 28.402123],
    "ia": [-96.639704, 40.375501, -90.140061, 43.501196],
    "id": [-117.243027, 41.988057, -111.043564, 49.001146],
    "il": [-91.513079, 36.970298, -87.495228, 42.508481],
    "in": [-88.09789, 37.771742, -84.784579, 41.760592],
    "ks": [-102.051744, 36.993016, -94.588413, 40.003162],
    "ky": [-89.571509, 36.497129, -81.964971, 39.147458],
    "la": [-94.043147, 28.925459, -88.817017, 33.019407],
    "ma": [-73.508142, 41.237964, -69.928393, 42.886589],
    "md": [-79.487651, 37.886605, -75.048939, 39.723043],
    "me": [-71.083903, 42.977764, -66.949895, 47.459686],
    "mi": [-90.418136, 41.696118, -82.418476, 48.306063],
    "mn": [-97.239209, 43.499356, -89.491739, 49.384358],
    "mo": [-95.774704, 35.995683, -89.098968, 40.61364],
    "ms": [-91.655009, 30.173943, -88.097888, 34.996052],
    "mt": [-116.050003, 44.358221, -104.039138, 49.001358],
    "nc": [-84.321869, 33.752877, -75.460621, 36.588117],
    "nd": [-104.0489, 45.935054, -96.554385, 49.000574],
    "ne": [-104.053514, 39.999932, -95.30829, 43.001708],
    "nh": [-72.557247, 42.696985, -70.610621, 45.305476],
    "nj": [-75.559614, 38.917576, -73.893979, 41.357423],
    "nm": [-109.050173, 31.332302, -103.001964, 37.000232],
    "nv": [-120.005746, 35.001857, -114.039648, 42.002207],
    "ny": [-79.762152, 40.477399, -71.856214, 45.015865],
    "oh": [-84.820159, 38.403202, -80.518626, 42.323373],
    "ok": [-103.002455, 33.615833, -94.430662, 37.002206],
    "or": [-124.703541, 41.991794, -116.463504, 46.292035],
    "pa": [-80.519891, 39.719799, -74.689516, 42.516072],
    "ri": [-71.862772, 41.146339, -71.12057, 42.018799],
    "sc": [-83.353238, 32.0346, -78.54203, 35.215408],
    "sd": [-104.057889, 42.479635, -96.436741, 45.94545],
    "tn": [-90.310298, 34.982957, -81.6469, 36.678255],
    "tx": [-106.645646, 25.837377, -93.508039, 36.500504],
    "ut": [-114.052962, 36.997968, -109.041058, 42.001567],
    "va": [-83.675315, 36.540738, -75.242266, 39.466012],
    "vt": [-73.43774, 42.726853, -71.503554, 45.016659],
    "wa": [-124.763068, 45.543541, -116.915989, 49.002494],
    "wi": [-92.888114, 42.491983, -86.83061, 47.080242],
    "wv": [-82.644739, 37.201483, -77.719519, 40.638845],
    "wy": [-111.056888, 40.994746, -104.05216, 45.005904]
}

class NoCacheStaticFiles(StaticFiles):
    def is_not_modified(self, response_headers: dict, request_headers: dict) -> bool:
        return False

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

app = FastAPI(title="Local ordered STAC")
# /search responses carry one presigned asset URL per feature, each ~1.5KB --
# dominated by the X-Amz-Security-Token, which is byte-for-byte identical across
# every URL (same execution-role session). gzip collapses that repetition to a
# fraction, so a few-hundred-KB search payload compresses dramatically. Function
# URLs don't auto-compress, so we do it here. minimum_size skips tiny responses.
app.add_middleware(GZipMiddleware, minimum_size=1024)
if VIEWER_DIR.exists():
    app.mount("/viewer", NoCacheStaticFiles(directory=VIEWER_DIR, html=True), name="viewer")
for mount_name, mount_dir in LOCAL_MODULE_DIRS.items():
    if mount_dir.exists():
        app.mount(f"/local-modules/{mount_name}", NoCacheStaticFiles(directory=mount_dir), name=f"local-{mount_name}")

_presign_cache: OrderedDict[str, tuple[float, str, dict[str, str]]] = OrderedDict()
_presign_cache_lock = Lock()
_ingest_jobs: OrderedDict[str, dict[str, Any]] = OrderedDict()
_ingest_jobs_lock = Lock()


def _set_ingest_job(job_id: str, payload: dict[str, Any]):
    with _ingest_jobs_lock:
        existing = _ingest_jobs.get(job_id, {})
        existing.update(payload)
        _ingest_jobs[job_id] = existing
        _ingest_jobs.move_to_end(job_id)
        while len(_ingest_jobs) > 20:
            _ingest_jobs.popitem(last=False)


def _append_ingest_log(job_id: str, line: str):
    with _ingest_jobs_lock:
        job = _ingest_jobs.setdefault(job_id, {})
        logs = list(job.get("logs", []))
        logs.append(line)
        job["logs"] = logs[-200:]
        _ingest_jobs[job_id] = job


def _get_ingest_job(job_id: str):
    with _ingest_jobs_lock:
        return _ingest_jobs.get(job_id)


# Standalone in-process DuckDB connection -- the only query engine. It reads the
# GeoParquet lake directly (read_parquet over LAKE_ROOT), so the whole service
# works with no database server, which is exactly the Lambda read profile. A
# single lazily-created connection is shared; queries use a per-call cursor() so
# concurrent FastAPI threadpool requests stay isolated.
_lake_duckdb_con = None
_lake_duckdb_lock = Lock()
_lake_duckdb_access_key = None
_lake_duckdb_expiry = 0.0


def get_lake_duckdb():
    global _lake_duckdb_con, _lake_duckdb_access_key, _lake_duckdb_expiry
    creds = get_aws_credentials()
    access_key = creds.get("aws_access_key_id")

    # If the connection exists, check if credentials changed or expired
    if _lake_duckdb_con is not None:
        if access_key != _lake_duckdb_access_key or time.time() > _lake_duckdb_expiry - 30:
            with _lake_duckdb_lock:
                if _lake_duckdb_con is not None:
                    try:
                        _lake_duckdb_con.close()
                    except Exception:
                        pass
                    _lake_duckdb_con = None

    if _lake_duckdb_con is None:
        with _lake_duckdb_lock:
            if _lake_duckdb_con is None:
                import duckdb

                import duckdb_s3

                con = duckdb.connect()

                # Load spatial + httpfs and (when either lake lives on S3) wire
                # credential_chain + requester-pays. See duckdb_s3 for the full
                # rationale; the helper is shared with the ingest path so reads
                # and writes configure DuckDB identically.
                duckdb_s3.configure(con, LAKE_ROOT, EMBED_LAKE_ROOT, spatial=True)

                _lake_duckdb_con = con
                _lake_duckdb_access_key = access_key
                if _cached_creds:
                    _lake_duckdb_expiry = _cached_creds[3]
                else:
                    _lake_duckdb_expiry = time.time() + 300
    return _lake_duckdb_con


def _is_expired_token_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "expiredtoken" in msg or "token has expired" in msg or "token included in the request is expired" in msg


def lake_query(run, *, retried: bool = False):
    """Run `run(cursor)` against the shared lake connection, self-healing on an
    expired S3 token.

    The DuckDB secret embeds a short-lived (~1h) STS token. The login-cache
    credential parser can hand back a token that has already expired on disk,
    and the rebuild heuristic in get_lake_duckdb() keys off the longer login
    *session* expiry -- so a stale secret can slip through. On an expired-token
    error, drop the cached credentials and connection (forcing a fresh
    resolution + secret) and retry exactly once."""
    global _lake_duckdb_con, _cached_creds
    try:
        return run(get_lake_duckdb().cursor())
    except Exception as exc:
        if retried or not _is_expired_token_error(exc):
            raise
        with _lake_duckdb_lock:
            if _lake_duckdb_con is not None:
                try:
                    _lake_duckdb_con.close()
                except Exception:
                    pass
                _lake_duckdb_con = None
        _cached_creds = None  # force get_aws_credentials() to re-resolve
        return lake_query(run, retried=True)



_cached_creds = None # (access_key_id, secret_access_key, session_token, expires_ts)


def load_login_session_credentials(profile_name: str) -> tuple[str, str, str, float] | None:
    home = Path(os.environ.get("HOME", "/root"))
    cache_dir = home / ".aws" / "login" / "cache"
    if not cache_dir.exists():
        return None

    target_account_id = None
    config_path = Path(os.environ.get("AWS_CONFIG_FILE", home / ".aws" / "config"))
    if config_path.exists():
        parser = configparser.RawConfigParser()
        parser.read(config_path)
        section_name = profile_name if profile_name == "default" else f"profile {profile_name}"
        if parser.has_section(section_name):
            login_session = parser.get(section_name, "login_session", fallback="").strip()
            if login_session.startswith("arn:"):
                arn_parts = login_session.split(":")
                if len(arn_parts) > 4 and arn_parts[4]:
                    target_account_id = arn_parts[4]

    fallback_creds = None
    for json_file in sorted(cache_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(json_file.read_text())
            access_token = data.get("accessToken", {})
            access_key_id = access_token.get("accessKeyId")
            secret_access_key = access_token.get("secretAccessKey")
            session_token = access_token.get("sessionToken")
            expires_at_str = access_token.get("expiresAt")
            account_id = access_token.get("accountId")
            if not (access_key_id and secret_access_key and session_token and expires_at_str):
                continue
            # expiresAt is UTC (trailing Z): parse tz-aware so .timestamp() is
            # correct. Parsing naive (stripping Z) treats it as local time, which
            # on a UTC-negative host over-reports validity by the UTC offset --
            # the bug that let an expired ~15min STS token look valid for hours,
            # so the s3-client / presign caches never refreshed it.
            expires_at_ts = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00")).timestamp()
            if expires_at_ts <= time.time() + 30:
                continue
            creds = (access_key_id, secret_access_key, session_token, expires_at_ts)
            if target_account_id and account_id == target_account_id:
                return creds
            if fallback_creds is None:
                fallback_creds = creds
        except Exception as exc:
            print(f"Error parsing AWS login cache {json_file}: {exc}", flush=True)
    return fallback_creds

def get_aws_credentials() -> dict[str, Any]:
    global _cached_creds
    now = time.time()
    if _cached_creds is not None and _cached_creds[3] > now + 30:
        return {
            "aws_access_key_id": _cached_creds[0],
            "aws_secret_access_key": _cached_creds[1],
            "aws_session_token": _cached_creds[2],
        }
    profile = os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE")
    session = boto3.session.Session(profile_name=profile) if profile else boto3.session.Session()
    try:
        resolved = session.get_credentials()
        # Freezing can raise too: refreshable login-session credentials throw
        # RuntimeError("...still expired") from _refresh() when the cached
        # token has lapsed.
        frozen = resolved.get_frozen_credentials() if resolved is not None else None
    except Exception as exc:
        # botocore without the [crt] extra raises MissingDependencyException
        # when the chain reaches an `aws login` session; fall through to our
        # own login-cache parser instead of failing the request.
        print(f"boto3 credential resolution failed ({exc}); trying login cache", flush=True)
        resolved = None
        frozen = None
    if frozen is None:
        fallback = load_login_session_credentials(profile or "default")
        if fallback is None:
            return {}
        _cached_creds = fallback
        return {
            "aws_access_key_id": fallback[0],
            "aws_secret_access_key": fallback[1],
            "aws_session_token": fallback[2],
        }

    expiry_time = getattr(resolved, "_expiry_time", None)
    expires_at_ts = expiry_time.timestamp() if expiry_time is not None else now + 300
    _cached_creds = (
        frozen.access_key,
        frozen.secret_key,
        frozen.token,
        expires_at_ts,
    )
    return {
        "aws_access_key_id": frozen.access_key,
        "aws_secret_access_key": frozen.secret_key,
        "aws_session_token": frozen.token,
    }

_global_s3_client = None
_global_s3_client_lock = Lock()
_global_s3_client_creds_expiry = 0.0

def get_s3_client():
    global _global_s3_client, _global_s3_client_creds_expiry
    now = time.time()
    
    with _global_s3_client_lock:
        if _global_s3_client is not None and _global_s3_client_creds_expiry > now + 30:
            return _global_s3_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        from botocore.config import Config
        s3_config = Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"}
        )
        creds = get_aws_credentials()
        # Cache expiry if available, fallback to 5 minutes
        _global_s3_client_creds_expiry = _cached_creds[3] if _cached_creds else now + 300.0

        client = boto3.client("s3", region_name=region, config=s3_config, **creds)

        # Move x-amz-request-payer from headers to query parameters before signing.
        # This signs it as a query param instead of a header, preventing browser CORS preflight checks.
        def move_request_payer_to_query(request, **kwargs):
            if "x-amz-request-payer" in request.headers:
                request.params["x-amz-request-payer"] = request.headers["x-amz-request-payer"]
                del request.headers["x-amz-request-payer"]
                
            # Remove Content-Type from GET/HEAD requests to prevent "SignatureDoesNotMatch"
            # caused by empty/default Content-Type headers being signed but not sent by the browser.
            if request.method in ("GET", "HEAD"):
                for h in list(request.headers.keys()):
                    if h.lower() == "content-type":
                        del request.headers[h]

        client.meta.events.register_first("before-sign.s3", move_request_payer_to_query)
        _global_s3_client = client
        return client


_global_s3_direct_client = None
_global_s3_direct_client_lock = Lock()
_global_s3_direct_client_creds_expiry = 0.0


def get_s3_direct_client():
    """S3 client for direct (non-presigned) server-side calls -- head_object,
    get_object, etc.

    Unlike get_s3_client(), this does NOT move x-amz-request-payer to a query
    parameter. That rewrite is correct for presigned URLs (a signed query param
    that the browser can use without a CORS preflight), but wrong for direct
    SigV4 requests: S3 only honors requester-pays as the x-amz-request-payer
    *header*, so a query param on a normal request is ignored and a
    requester-pays bucket returns 403 AccessDenied. Direct calls must therefore
    send the header, which boto3 does natively from RequestPayer=... .
    """
    global _global_s3_direct_client, _global_s3_direct_client_creds_expiry
    now = time.time()
    with _global_s3_direct_client_lock:
        if _global_s3_direct_client is not None and _global_s3_direct_client_creds_expiry > now + 30:
            return _global_s3_direct_client

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        from botocore.config import Config
        s3_config = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
        creds = get_aws_credentials()
        _global_s3_direct_client_creds_expiry = _cached_creds[3] if _cached_creds else now + 300.0
        _global_s3_direct_client = boto3.client(
            "s3", region_name=region, config=s3_config, **creds
        )
        return _global_s3_direct_client


def _token_bounded_expires_in() -> int:
    """How long a freshly-signed URL is actually valid for. A presigned URL
    cannot outlive the STS token that signed it, and login-session tokens are
    short (~15 min) and rotate on disk. So bound ExpiresIn (and our cache TTL)
    to the token's remaining life minus a safety margin -- never hand out, or
    cache, a URL that dies mid-use. get_s3_client()/get_aws_credentials() pick
    up the rotated token on their own ~token-cadence rebuild (the presign
    self-heal), so the next sign uses fresh creds."""
    now = time.time()
    token_left = int(_cached_creds[3] - now) if _cached_creds else PRESIGN_EXPIRES
    return max(1, min(PRESIGN_EXPIRES, token_left - 30))


def _get_cached_presigned_href(href: str):
    if PRESIGN_CACHE_TTL <= 0:
        return None
    now = monotonic()
    with _presign_cache_lock:
        cached = _presign_cache.get(href)
        if cached is None:
            return None
        expires_at, signed_href, headers = cached
        if expires_at <= now:
            _presign_cache.pop(href, None)
            return None
        _presign_cache.move_to_end(href)
        return signed_href, headers


def _presigned_remaining(href: str) -> int | None:
    """Seconds a cached signed URL is still valid (bounded by token life, since
    the cache TTL is token-bounded at store time). None if not cached."""
    if PRESIGN_CACHE_TTL <= 0:
        return None
    with _presign_cache_lock:
        cached = _presign_cache.get(href)
        if cached is None:
            return None
        return max(0, int(cached[0] - monotonic()))


def _store_cached_presigned_href(href: str, signed_href: str, headers: dict[str, str], ttl: int | None = None):
    # Never cache longer than the URL is valid: bound to the token-limited life.
    eff_ttl = PRESIGN_CACHE_TTL if ttl is None else min(PRESIGN_CACHE_TTL, ttl)
    if eff_ttl <= 0:
        return
    expires_at = monotonic() + eff_ttl
    with _presign_cache_lock:
        _presign_cache[href] = (expires_at, signed_href, headers)
        _presign_cache.move_to_end(href)
        while len(_presign_cache) > PRESIGN_CACHE_MAXSIZE:
            _presign_cache.popitem(last=False)


def _validate_signable_s3_href(href: str):
    """Parse an S3 href and restrict signing to registered source buckets."""
    parsed = urlparse(href)
    key = parsed.path.lstrip("/")
    if (
        parsed.scheme != "s3"
        or not parsed.netloc
        or not key
        or parsed.query
        or parsed.fragment
        or "@" in parsed.netloc
        or ":" in parsed.netloc
    ):
        raise HTTPException(status_code=400, detail="href must be an s3://bucket/key URL")

    import descriptors

    if not descriptors.is_source_asset(parsed.netloc, key):
        raise HTTPException(
            status_code=403,
            detail="S3 object is not an allowed collection source asset",
        )
    return parsed, key


def _sign_s3_href_uncached(href: str):
    parsed, key = _validate_signable_s3_href(href)
    bucket = parsed.netloc
    params: dict[str, Any] = {"Bucket": bucket, "Key": key}
    if REQUEST_PAYER:
        params["RequestPayer"] = REQUEST_PAYER

    expires_in = _token_bounded_expires_in()
    try:
        signed = get_s3_client().generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=expires_in,
        )
    except CredentialRetrievalError as exc:
        raise HTTPException(
            status_code=503,
            detail="AWS credentials expired; reauthenticate with 'aws login' to resume signed COG access.",
        ) from exc
    except BotoCoreError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to sign COG URL: {exc}",
        ) from exc
    headers: dict[str, str] = {}
    _store_cached_presigned_href(href, signed, headers, ttl=expires_in)
    return signed, headers


def maybe_sign_s3_href(href: str | None, stats: dict[str, float | int] | None = None):
    """Returns (signed_href, headers, expires_in). expires_in is the URL's real
    remaining validity (token-bounded) so the caller/browser re-signs before the
    short-lived STS token dies, rather than trusting a fixed PRESIGN_EXPIRES."""
    if not href or not href.startswith("s3://") or not SIGN_ASSET_URLS:
        return href, {}, 0

    cached = _get_cached_presigned_href(href)
    if cached is not None:
        if stats is not None:
            stats["presign_cache_hits"] = int(stats.get("presign_cache_hits", 0)) + 1
        signed, headers = cached
        return signed, headers, (_presigned_remaining(href) or _token_bounded_expires_in())

    started_at = monotonic()
    signed, headers = _sign_s3_href_uncached(href)
    if stats is not None:
        stats["presign_cache_misses"] = int(stats.get("presign_cache_misses", 0)) + 1
        stats["presign_seconds"] = float(stats.get("presign_seconds", 0.0)) + (monotonic() - started_at)
    return signed, headers, (_presigned_remaining(href) or _token_bounded_expires_in())


def prepare_signed_hrefs(features: list[dict[str, Any]], stats: dict[str, float | int] | None = None):
    href_map: dict[str, tuple[str, dict[str, str]]] = {}
    cache_miss_hrefs: list[str] = []

    for feature in features:
        assets = feature.get("assets")
        if not isinstance(assets, dict):
            continue
        image_asset = assets.get("image")
        if not isinstance(image_asset, dict):
            continue
        original_href = image_asset.get("href")
        if not isinstance(original_href, str) or not original_href.startswith("s3://") or not SIGN_ASSET_URLS:
            continue
        if original_href in href_map:
            continue
        cached = _get_cached_presigned_href(original_href)
        if cached is not None:
            href_map[original_href] = cached
            if stats is not None:
                stats["presign_cache_hits"] = int(stats.get("presign_cache_hits", 0)) + 1
        else:
            cache_miss_hrefs.append(original_href)

    if cache_miss_hrefs:
        worker_count = min(PRESIGN_MAX_WORKERS, len(cache_miss_hrefs))
        started_at = monotonic()
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {executor.submit(_sign_s3_href_uncached, href): href for href in cache_miss_hrefs}
            for future in as_completed(futures):
                href = futures[future]
                href_map[href] = future.result()
        if stats is not None:
            stats["presign_cache_misses"] = int(stats.get("presign_cache_misses", 0)) + len(cache_miss_hrefs)
            stats["presign_seconds"] = float(stats.get("presign_seconds", 0.0)) + (monotonic() - started_at)

    return href_map


def rewrite_feature_assets(feature: dict[str, Any], signed_hrefs: dict[str, tuple[str, dict[str, str]]] | None = None):
    assets = feature.get("assets")
    if not isinstance(assets, dict):
        return feature

    image_asset = assets.get("image")
    if isinstance(image_asset, dict):
        original_href = image_asset.get("href")
        signed_entry = signed_hrefs.get(original_href) if isinstance(original_href, str) and signed_hrefs else None
        if signed_entry is not None:
            signed_href, headers = signed_entry
            image_asset["href"] = signed_href
            image_asset["headers"] = headers
            image_asset["source:href"] = original_href

    assets.pop("metadata", None)
    return feature


@app.get("/health")
def health():
    get_lake_duckdb().cursor().execute("select 1").fetchone()
    return {"ok": True}


def _infer_auth_mode():
    profile = os.environ.get("AWS_PROFILE")
    if profile:
        return f"profile:{profile}"
    if os.environ.get("AWS_WEB_IDENTITY_TOKEN_FILE"):
        return "web-identity"
    if os.environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") or os.environ.get("AWS_CONTAINER_CREDENTIALS_FULL_URI"):
        return "container-role"
    return "ambient-or-role"


def _probe_earthsearch():
    request = Request(
        EARTHSEARCH_API,
        data=b'{"collections":["naip"],"limit":1}',
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            return {
                "ok": True,
                "status_code": getattr(response, "status", None),
                "url": EARTHSEARCH_API,
            }
    except HTTPError as exc:
        return {"ok": False, "status_code": exc.code, "error": str(exc), "url": EARTHSEARCH_API}
    except URLError as exc:
        return {"ok": False, "error": str(exc), "url": EARTHSEARCH_API}


def _probe_s3_access():
    try:
        row = (
            get_lake_duckdb()
            .cursor()
            .execute(
                f"""
                select asset_href
                from read_parquet('{LAKE_ROOT}/collection=*/**/*.parquet', hive_partitioning=true)
                where asset_href like 's3://%'
                order by source_key asc
                limit 1
                """
            )
            .fetchone()
        )
    except Exception as exc:
        return {"ok": False, "error": f"Lake probe query failed: {exc}", "request_payer": REQUEST_PAYER}
    if not row:
        return {"ok": False, "error": "No S3-backed assets available for probe.", "request_payer": REQUEST_PAYER}

    href = row[0]
    parsed = urlparse(href)
    params: dict[str, Any] = {"Bucket": parsed.netloc, "Key": parsed.path.lstrip("/")}
    if REQUEST_PAYER:
        params["RequestPayer"] = REQUEST_PAYER
    try:
        get_s3_direct_client().head_object(**params)
        return {
            "ok": True,
            "bucket": params["Bucket"],
            "key": params["Key"],
            "request_payer": REQUEST_PAYER,
        }
    except (BotoCoreError, ClientError) as exc:
        return {
            "ok": False,
            "bucket": params["Bucket"],
            "key": params["Key"],
            "request_payer": REQUEST_PAYER,
            "error": str(exc),
        }


def _probe_manifest_index():
    """Confirm the Parquet manifest index is reachable (local dir or s3://).

    Uses DuckDB's glob() table function, which only LISTs the partition tree
    (no row scan), so this is a cheap reachability check. The lake DuckDB
    connection is already wired for httpfs + requester-pays when LAKE_ROOT is
    s3://, and the manifest index lives in the same bucket.
    """
    is_s3 = str(MANIFEST_INDEX).startswith("s3://")
    if not is_s3 and not Path(MANIFEST_INDEX).exists():
        return {"ok": False, "path": str(MANIFEST_INDEX), "error": "manifest index path does not exist"}
    glob = f"{MANIFEST_INDEX}/**/*.parquet"
    try:
        count = (
            get_lake_duckdb()
            .cursor()
            .execute(f"select count(*) from glob('{glob}')")
            .fetchone()[0]
        )
    except Exception as exc:
        return {"ok": False, "path": str(MANIFEST_INDEX), "error": f"manifest index probe failed: {exc}"}
    if not count:
        return {"ok": False, "path": str(MANIFEST_INDEX), "file_count": 0, "error": "no parquet files found under manifest index"}
    result = {"ok": True, "path": str(MANIFEST_INDEX), "file_count": int(count)}
    result.update(_probe_manifest_freshness())
    return result


def _parse_s3_uri(uri: str) -> tuple[str, str]:
    rest = uri[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return bucket, key


def _probe_manifest_freshness() -> dict[str, Any]:
    """Compare the published manifest's LastModified to the newest object in the
    index. If the source is newer, AWS has republished it (new COGs) and the
    index should be rebuilt. Only meaningful when both are s3://; otherwise the
    freshness fields are omitted (still leaving ok/file_count intact)."""
    if not (str(MANIFEST_SOURCE).startswith("s3://") and str(MANIFEST_INDEX).startswith("s3://")):
        return {}
    out: dict[str, Any] = {"source": str(MANIFEST_SOURCE)}
    try:
        s3 = get_s3_direct_client()
        src_bucket, src_key = _parse_s3_uri(MANIFEST_SOURCE)
        src = s3.head_object(Bucket=src_bucket, Key=src_key, RequestPayer="requester")
        source_modified = src["LastModified"]
        out["source_modified"] = source_modified.isoformat()

        idx_bucket, idx_prefix = _parse_s3_uri(MANIFEST_INDEX.rstrip("/"))
        newest = None
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=idx_bucket, Prefix=idx_prefix + "/"):
            for obj in page.get("Contents", []):
                lm = obj["LastModified"]
                if newest is None or lm > newest:
                    newest = lm
        if newest is not None:
            out["index_built"] = newest.isoformat()
            out["stale"] = source_modified > newest
    except Exception as exc:
        out["freshness_error"] = str(exc)
    return out


@app.get("/environment")
def environment():
    db_status = {"ok": False}
    auth_identity: dict[str, Any] | None = None
    auth_error = None
    s3_status: dict[str, Any] = {"ok": False, "error": "Lake probe not attempted."}
    try:
        get_lake_duckdb().cursor().execute("select 1").fetchone()
        db_status = {"ok": True, "engine": "duckdb", "lake_root": LAKE_ROOT}
        s3_status = _probe_s3_access()
    except Exception as exc:
        db_status = {"ok": False, "error": str(exc)}
        s3_status = {"ok": False, "error": "Skipped because DuckDB health check failed."}

    try:
        auth_identity = boto3.client("sts", **get_aws_credentials()).get_caller_identity()
    except Exception as exc:
        auth_error = str(exc)

    return {
        "auth_mode": _infer_auth_mode(),
        "auth_identity": {
            "ok": auth_identity is not None,
            "arn": auth_identity.get("Arn") if auth_identity else None,
            "account": auth_identity.get("Account") if auth_identity else None,
            "error": auth_error,
        },
        "s3_access_status": s3_status,
        "manifest_index": _probe_manifest_index(),
        "db": db_status,
        "earthsearch": _probe_earthsearch(),
        # "sync" on Lambda (background threads/subprocesses die when the env
        # freezes, so the viewer must use the in-process /ingest/run-sync);
        # "async" everywhere else (thread+subprocess /ingest/run with polling).
        "ingest_mode": INGEST_MODE,
        # When set (read-only zip Lambda), the viewer POSTs ingest here -- the
        # dedicated container ingest function -- instead of this origin.
        "ingest_url": INGEST_URL or None,
        "effective_config": {
            "collection_id": COLLECTION_ID,
            "aws_region": os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
            "sign_asset_urls": SIGN_ASSET_URLS,
            "presign_expires": PRESIGN_EXPIRES,
            "presign_cache_ttl": PRESIGN_CACHE_TTL,
            "presign_cache_maxsize": PRESIGN_CACHE_MAXSIZE,
            "presign_max_workers": PRESIGN_MAX_WORKERS,
            "request_payer": REQUEST_PAYER,
            "manifest_index": str(MANIFEST_INDEX),
            "earthsearch_api": EARTHSEARCH_API,
            "earthsearch_page_size": EARTHSEARCH_PAGE_SIZE,
        },
    }


@app.get("/")
def root():
    return {
        "stac_version": "1.0.0",
        "type": "Catalog",
        "id": "cog-local",
        "title": "Local COG STAC catalog",
        "description": "Local object-key-first STAC catalog serving COG collections",
        "links": [
            {"rel": "self", "href": "/"},
            {"rel": "data", "href": "/collections"},
            {"rel": "search", "href": "/search"},
            {"rel": "alternate", "href": "/viewer/"},
        ],
    }


def lake_collections() -> list[str]:
    """Collection ids actually present in the lake, from the collection= partition
    dirs (path listing -- no DuckDB, no parquet reads). Drives the viewer's
    collection selector: only collections you can actually search are offered."""
    root = str(LAKE_ROOT)
    out: list[str] = []
    try:
        if root.startswith("s3://"):
            bucket, _, prefix = root[len("s3://"):].partition("/")
            base = (prefix.rstrip("/") + "/") if prefix else ""
            paginator = get_s3_client().get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=base, Delimiter="/"):
                for cp in page.get("CommonPrefixes", []):
                    seg = cp["Prefix"].rstrip("/").rsplit("/", 1)[-1]
                    if seg.startswith("collection="):
                        out.append(seg.split("=", 1)[1])
        else:
            from pathlib import Path as _Path

            for d in _Path(root).glob("collection=*"):
                if d.is_dir():
                    out.append(d.name.split("=", 1)[1])
    except Exception as exc:
        print(f"lake_collections listing failed: {exc}", flush=True)
    return sorted(set(out))


@app.get("/collections")
def collections():
    ids = lake_collections() or [COLLECTION_ID]
    return {
        "collections": [
            {
                "id": cid,
                "type": "Collection",
                "title": cid.upper(),
                "links": [
                    {"rel": "self", "href": f"/collections/{cid}"},
                    {"rel": "items", "href": "/search"},
                ],
            }
            for cid in ids
        ],
        "links": [{"rel": "self", "href": "/collections"}],
    }


@app.get("/collections/{collection_id}")
def collection(collection_id: str):
    for c in collections()["collections"]:
        if c["id"] == collection_id:
            return c
    raise HTTPException(status_code=404, detail="Collection not found")


@lru_cache(maxsize=1)
def load_manifest_states_years() -> dict[str, set[int]]:
    """State→years universe of ingestable NAIP data, derived from the manifest
    index PARTITION PATHS (state=.../naip_year=...).

    This lists directory prefixes only -- it never opens a parquet file -- so
    cold start stays fast and O(#partitions) regardless of how many files the
    index has. (The prior version scanned every parquet to recover values that
    are already encoded in the path, which timed out the Lambda once the index
    grew to cover 2022/2023 nationwide.)"""
    manifest_map: dict[str, set[int]] = {}
    root = str(MANIFEST_INDEX)
    try:
        if root.startswith("s3://"):
            bucket, _, prefix = root[len("s3://"):].partition("/")
            base = (prefix.rstrip("/") + "/") if prefix else ""
            s3 = get_s3_client()
            paginator = s3.get_paginator("list_objects_v2")
            for sp in paginator.paginate(Bucket=bucket, Prefix=base, Delimiter="/"):
                for cp in sp.get("CommonPrefixes", []):
                    seg = cp["Prefix"].rstrip("/").rsplit("/", 1)[-1]
                    if not seg.startswith("state="):
                        continue
                    state = seg.split("=", 1)[1].strip().lower()
                    for yp in paginator.paginate(Bucket=bucket, Prefix=cp["Prefix"], Delimiter="/"):
                        for ycp in yp.get("CommonPrefixes", []):
                            yseg = ycp["Prefix"].rstrip("/").rsplit("/", 1)[-1]
                            if yseg.startswith("naip_year="):
                                try:
                                    manifest_map.setdefault(state, set()).add(
                                        int(yseg.split("=", 1)[1])
                                    )
                                except ValueError:
                                    pass
        else:
            from pathlib import Path as _Path

            for sdir in _Path(root).glob("state=*"):
                state = sdir.name.split("=", 1)[1].strip().lower()
                for ydir in sdir.glob("naip_year=*"):
                    try:
                        manifest_map.setdefault(state, set()).add(
                            int(ydir.name.split("=", 1)[1])
                        )
                    except ValueError:
                        pass
    except Exception as exc:
        print(f"Error listing manifest index {root}: {exc}", flush=True)
    return manifest_map


def lake_years_for_states(states: set[str]) -> dict[str, set[int]]:
    """Ingested years per region from the LAKE partition paths
    (collection=<id>/region=.../year=...), for the given regions only -- no DuckDB,
    no parquet reads. Scoped to COLLECTION_ID. Deliberately NOT cached: the lake
    changes on every ingest, and listing a handful of viewport regions' prefixes
    is cheap (~a few ListObjects)."""
    out: dict[str, set[int]] = {}
    if not states:
        return out
    root = str(LAKE_ROOT)
    try:
        if root.startswith("s3://"):
            bucket, _, prefix = root[len("s3://"):].partition("/")
            base = (prefix.rstrip("/") + "/") if prefix else ""
            s3 = get_s3_client()
            paginator = s3.get_paginator("list_objects_v2")
            for st in states:
                for page in paginator.paginate(
                    Bucket=bucket,
                    Prefix=f"{base}collection={COLLECTION_ID}/region={st}/",
                    Delimiter="/",
                ):
                    for cp in page.get("CommonPrefixes", []):
                        seg = cp["Prefix"].rstrip("/").rsplit("/", 1)[-1]
                        if seg.startswith("year="):
                            try:
                                out.setdefault(st, set()).add(int(seg.split("=", 1)[1]))
                            except ValueError:
                                pass
        else:
            from pathlib import Path as _Path

            for st in states:
                sdir = _Path(root) / f"collection={COLLECTION_ID}" / f"region={st}"
                if sdir.is_dir():
                    for ydir in sdir.glob("year=*"):
                        try:
                            out.setdefault(st, set()).add(int(ydir.name.split("=", 1)[1]))
                        except ValueError:
                            pass
    except Exception as exc:
        print(f"lake_years_for_states listing failed: {exc}", flush=True)
    return out


def _bboxes_intersect(box1: list[float], box2: list[float]) -> bool:
    minx1, miny1, maxx1, maxy1 = box1
    minx2, miny2, maxx2, maxy2 = box2
    # Extremely wide / antimeridian-wrapping box1 -> ignore longitude constraints.
    if (maxx1 - minx1) >= 360 or minx1 > maxx1:
        return not (maxy1 < miny2 or miny1 > maxy2)
    return not (maxx1 < minx2 or minx1 > maxx2 or maxy1 < miny2 or miny1 > maxy2)


@lru_cache(maxsize=64)
def _cached_available_years(collection_id: str, region: str) -> tuple[int, ...]:
    """Source years offerable for a (generic) collection's region, cached because
    /ingest/options is called on pan and the source rarely changes."""
    import descriptors

    disc = descriptors.get_descriptor(collection_id).discovery
    if hasattr(disc, "available_years"):
        return tuple(disc.available_years(region))
    return tuple()


@app.post("/ingest/options")
def ingest_options(body: dict[str, Any]):
    bbox = body.get("bbox")
    if not bbox or len(bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox is required and must be [minx, miny, maxx, maxy]")

    import descriptors
    collection = "".join(ch for ch in str(body.get("collection", COLLECTION_ID)).lower() if ch.isalnum() or ch in "-_") or COLLECTION_ID
    ingestable = sorted(descriptors._REGISTRY)  # collections the panel can offer

    if collection == COLLECTION_ID:
        # NAIP: states overlapping the viewport, years from manifest index + lake.
        manifest_map = load_manifest_states_years()
        es_states: dict[str, set[int]] = {}
        for state, state_bbox in STATE_BBOXES.items():
            if _bboxes_intersect(bbox, state_bbox) and state in manifest_map:
                es_states[state] = set(manifest_map[state])
        # Already-ingested years from the LAKE partition paths (no DuckDB).
        db_states = lake_years_for_states(set(es_states.keys()))
        merged: dict[str, set[int]] = {}
        for st, years in db_states.items():
            merged[st] = set(years)
        for st, years in es_states.items():
            merged.setdefault(st, set()).update(years)
        states = [{"state": st, "years": sorted(merged[st], reverse=True)} for st in sorted(merged)]
        strategies = [
            {"id": "manifest-earthsearch", "label": "Manifest + EarthSearch STAC", "available": True},
            {"id": "manifest-cog-headers", "label": "Manifest + COG headers", "available": True},
        ]
    else:
        # Generic S3PrefixListing collection: offer its region(s) that overlap the
        # viewport (coarse STATE_BBOXES test), with source years from the bucket.
        try:
            disc = descriptors.get_descriptor(collection).discovery
        except SystemExit:
            raise HTTPException(status_code=400, detail=f"unknown collection '{collection}'")
        states = []
        for r in (getattr(disc, "regions", ()) or ()):
            sb = STATE_BBOXES.get(r)
            if sb and not _bboxes_intersect(bbox, sb):
                continue
            states.append({"state": r, "years": list(_cached_available_years(collection, r))})
        strategies = [{"id": "manifest-cog-headers", "label": "COG headers", "available": True}]

    return {"collection": collection, "collections": ingestable, "states": states, "strategies": strategies}


def _run_ingest_job(
    job_id: str,
    state: str,
    year: int | None,
    strategy: str,
    limit_per_partition: int | None = None,
    collection: str = COLLECTION_ID,
):
    command = [sys.executable, str(INGEST_SCRIPT_PATH),
               "--collection", collection, "--states", state, "--strategy", strategy]
    if year is not None:
        command.extend(["--years", str(year)])
    # 0 / None means "all" (the CLI default), so only pass the flag when a
    # positive cap was requested from the panel.
    if limit_per_partition:
        command.extend(["--limit-per-partition", str(limit_per_partition)])
    try:
        _append_ingest_log(job_id, f"$ {' '.join(command)}")
        result = subprocess.run(
            command,
            cwd=str(Path(__file__).parent),
            capture_output=True,
            text=True,
            env=os.environ.copy(),
        )
        for line in (result.stdout or "").splitlines():
            _append_ingest_log(job_id, line)
        for line in (result.stderr or "").splitlines():
            _append_ingest_log(job_id, f"stderr: {line}")
        if result.returncode == 0:
            _set_ingest_job(job_id, {"status": "completed", "returncode": result.returncode, "finished": monotonic()})
        else:
            _set_ingest_job(
                job_id,
                {
                    "status": "failed",
                    "returncode": result.returncode,
                    "error": f"Ingest command exited with code {result.returncode}.",
                    "finished": monotonic(),
                },
            )
    except Exception as exc:
        _set_ingest_job(job_id, {"status": "failed", "error": str(exc), "finished": monotonic()})


@app.post("/ingest/run")
def ingest_run(body: dict[str, Any]):
    state = str(body.get("state") or "").strip().lower()
    if not state:
        raise HTTPException(status_code=400, detail="state is required")
    # Require a single explicit year. Ingesting "all years" fans out into one
    # EarthSearch STAC query per page across every year -- too aggressive on the
    # public endpoint -- so the panel must pick exactly one year at a time.
    year = body.get("year")
    if year in (None, "", "latest", "all"):
        raise HTTPException(
            status_code=400,
            detail="a single year is required (ingest one year at a time)",
        )
    try:
        year = int(year)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"invalid year: {year!r}")
    # Default to COG-headers: authoritative + complete, works for any collection,
    # no third-party STAC dependency. manifest-earthsearch can silently drop tiles
    # (it once ingested 430 of WA-2023's 5,720) and is kept only as opt-in.
    strategy = str(body.get("strategy") or "manifest-cog-headers")
    collection = str(body.get("collection") or COLLECTION_ID)
    # Optional per-partition cap; absent/0 means "all" (CLI default).
    raw_limit = body.get("limit_per_partition")
    try:
        limit_per_partition = int(raw_limit) if raw_limit not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid limit_per_partition")
    if limit_per_partition is not None and limit_per_partition < 0:
        raise HTTPException(status_code=400, detail="limit_per_partition must be >= 0")
    job_id = uuid4().hex
    _set_ingest_job(
        job_id,
        {
            "id": job_id,
            "status": "running",
            "collection": collection,
            "state": state,
            "year": year,
            "strategy": strategy,
            "limit_per_partition": limit_per_partition,
            "logs": [],
        },
    )
    thread = Thread(
        target=_run_ingest_job,
        args=(job_id, state, year, strategy, limit_per_partition, collection),
        daemon=True,
    )
    thread.start()
    return {"job_id": job_id, "status": "running"}


@app.get("/ingest/status/{job_id}")
def ingest_status(job_id: str):
    job = _get_ingest_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Ingest job not found")
    return job


# Default + ceiling on rows per (state, year, resolution) partition for the
# synchronous path. Keeps a single request well under the HTTP API 30s timeout
# by bounding the STAC/COG fan-out; raise as confidence grows.
SYNC_INGEST_DEFAULT_LIMIT = int(os.environ.get("S3_COG_SYNC_INGEST_DEFAULT_LIMIT", "50"))
SYNC_INGEST_MAX_LIMIT = int(os.environ.get("S3_COG_SYNC_INGEST_MAX_LIMIT", "500"))


@app.post("/ingest/run-sync")
def ingest_run_sync(body: dict[str, Any]):
    """Run a single (state, year) ingest synchronously, in-process, and return
    the result in the response.

    This is the Lambda-compatible path: it does NOT spawn a background thread or
    subprocess (both die when Lambda freezes the env after the response) and
    keeps no cross-request job state. Intended for small states / single years
    that finish within the function timeout; larger ingests need an async path
    (Step Functions / a longer-timeout worker), tracked separately.
    """
    # The read-only zip Lambda is deployed without the ingest deps
    # (pyarrow/pyproj/pillow), so signal that clearly instead of ImportError-ing
    # deep inside acquire_payloads/export.
    if INGEST_MODE == "disabled":
        raise HTTPException(
            status_code=501,
            detail="ingest is not available on this deployment (read-only)",
        )

    state = str(body.get("state") or "").strip().lower()
    if not state:
        raise HTTPException(status_code=400, detail="state is required")

    # Same single-year guard as /ingest/run: one explicit year, no fan-out.
    year = body.get("year")
    if year in (None, "", "latest", "all"):
        raise HTTPException(
            status_code=400,
            detail="a single year is required (ingest one year at a time)",
        )
    try:
        year = int(year)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"invalid year: {year!r}")

    # Default to COG-headers: authoritative + complete, works for any collection,
    # no third-party STAC dependency. manifest-earthsearch can silently drop tiles
    # (it once ingested 430 of WA-2023's 5,720) and is kept only as opt-in.
    strategy = str(body.get("strategy") or "manifest-cog-headers")
    if strategy not in ("manifest-earthsearch", "manifest-cog-headers"):
        raise HTTPException(status_code=400, detail=f"invalid strategy: {strategy!r}")

    # Cap COGs per partition to bound runtime; 0 means unlimited (no cap). The
    # sync path runs in the ingest Lambda's 900s budget (~50 COG-header reads/s
    # warm => ~tens of thousands of tiles fit); huge partitions want the CLI/async.
    raw_limit = body.get("limit_per_partition")
    try:
        limit = int(raw_limit) if raw_limit not in (None, "") else SYNC_INGEST_DEFAULT_LIMIT
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid limit_per_partition")
    if limit < 0 or (limit > 0 and limit > SYNC_INGEST_MAX_LIMIT):
        raise HTTPException(
            status_code=400,
            detail=f"limit_per_partition must be 0 (unlimited) or between 1 and {SYNC_INGEST_MAX_LIMIT}",
        )

    # Lazy import: keep duckdb/ingest off the cold-start path for non-ingest
    # requests (the read API is the common case).
    import ingest_duckdb as ig
    from types import SimpleNamespace

    collection = str(body.get("collection") or COLLECTION_ID)
    args = SimpleNamespace(
        collection=collection,
        states=[state],
        years=[year],
        latest_year_only=False,
        limit_per_partition=limit,
        strategy=strategy,
        page_size=ig.im.EARTHSEARCH_PAGE_SIZE,
        out=LAKE_ROOT,
        row_group_size=2000,
        single_file=False,
        strict_completeness=False,  # warn-only in the API path (CLI gets it from argparse)
    )

    started = monotonic()
    try:
        payloads = ig.acquire_payloads(args)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ingest acquisition failed: {exc}")

    # No assets for this (state, year): export() would crash on an empty table,
    # so return a clear "nothing to ingest" result instead of a 500.
    if not payloads:
        return {
            "status": "no_data",
            "state": state,
            "year": year,
            "strategy": strategy,
            "limit_per_partition": limit,
            "rows_ingested": 0,
            "elapsed_ms": round((monotonic() - started) * 1000, 1),
            "detail": "no assets found for this state/year in the manifest index",
        }

    try:
        # export() returns a count over the whole lake glob, not just this run,
        # so report the payload count as rows_ingested for an accurate signal.
        lake_total = ig.export(payloads, args.out, args.row_group_size, args.single_file, args.collection)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ingest export failed: {exc}")

    # New state/year may now be queryable; drop the cached availability map.
    load_manifest_states_years.cache_clear()

    return {
        "status": "completed",
        "state": state,
        "year": year,
        "strategy": strategy,
        "limit_per_partition": limit,
        "rows_ingested": len(payloads),
        "lake_total_rows": int(lake_total),
        "elapsed_ms": round((monotonic() - started) * 1000, 1),
        "out": str(LAKE_ROOT),
    }


def make_stac_feature(row) -> dict[str, Any]:
    (source_bucket, source_key, geom_json, xmin, ymin, xmax, ymax, acq_date, gsd,
     collection, region, year, properties_json, proj_epsg, proj_shape,
     proj_transform, asset_href) = row

    geometry = geom_json if isinstance(geom_json, dict) else json.loads(geom_json) if geom_json else None

    extra: dict[str, Any] = {}
    if properties_json:
        try:
            extra = json.loads(properties_json) if isinstance(properties_json, str) else dict(properties_json)
        except (TypeError, ValueError):
            extra = {}

    props = {
        'datetime': f"{acq_date.isoformat()}T00:00:00Z" if acq_date else None,
        'gsd': gsd,
        'region': region,
        'year': year,
        # back-compat aliases the current (Phase-3) viewer still reads:
        'naip:state': region,
        'naip:year': year,
        'proj:epsg': proj_epsg,
        'proj:shape': proj_shape,
        'proj:transform': proj_transform,
    }
    # Merge collection-scoped properties (e.g. naip:quad/resolution/product).
    for k, v in extra.items():
        props.setdefault(k, v)
    quad = extra.get('naip:quad')
    if quad:
        props.setdefault('grid:code', f"DOQQ-{quad}")

    feature = {
        'type': 'Feature',
        'stac_version': '1.0.0',
        'stac_extensions': [],
        'id': f"{source_bucket}/{source_key}",
        'collection': collection or COLLECTION_ID,
        'geometry': geometry,
        'bbox': [xmin, ymin, xmax, ymax],
        'properties': {k: v for k, v in props.items() if v is not None},
        'assets': {
            'image': {
                'href': asset_href,
                'type': 'image/tiff; application=geotiff; profile=cloud-optimized',
                'roles': ['data']
            }
        }
    }
    return feature

@app.get("/availability")
def availability(collection: str = COLLECTION_ID):
    """Region -> available years (newest first) for ONE collection, read from the
    GeoParquet lake via the in-process DuckDB connection.

    Powers the viewer's dependent Region->Year dropdowns. Scoped to a single
    collection (default naip) so a second collection's regions never pollute
    another's dropdown; the viewer passes ?collection=<selected>."""
    collection = "".join(ch for ch in str(collection).lower() if ch.isalnum() or ch in "-_") or COLLECTION_ID
    states: dict[str, list[int]] = {}
    # Per region/year best (finest) gsd in meters, so the viewer can annotate
    # the Year dropdown ("2023 - 30 cm"). min() rather than assuming uniformity:
    # a mixed-resolution state-year shows its finest, which is also what
    # /detect's `order by gsd asc` would pick.
    gsd: dict[str, dict[str, float]] = {}
    # Per region/year footprint extent [xmin, ymin, xmax, ymax] (EPSG:4326),
    # so the viewer can fly to a Collection/Region/Year selection.
    extent: dict[str, dict[str, list[float]]] = {}
    # {states:{region:[years]}} response shape kept stable for the viewer;
    # `gsd` ({region:{year: meters}}) and `extent` are additive.
    lake_sql = (
        f"select region, year, min(gsd), min(bbox_xmin), min(bbox_ymin), max(bbox_xmax), max(bbox_ymax) "
        f"from read_parquet('{LAKE_ROOT}/collection={collection}/**/*.parquet', hive_partitioning=true) "
        "group by region, year"
    )
    try:
        for state, year, year_gsd, xmin, ymin, xmax, ymax in get_lake_duckdb().cursor().execute(lake_sql).fetchall():
            if state is not None and year is not None:
                region = str(state).strip().lower()
                states.setdefault(region, []).append(int(year))
                if year_gsd is not None:
                    gsd.setdefault(region, {})[str(int(year))] = float(year_gsd)
                if None not in (xmin, ymin, xmax, ymax):
                    extent.setdefault(region, {})[str(int(year))] = [float(xmin), float(ymin), float(xmax), float(ymax)]
        for st in list(states):
            states[st] = sorted(set(states[st]), reverse=True)
    except Exception as exc:
        # An empty/not-yet-populated lake (no collection= files) raises an IO error
        # rather than returning empty -- treat that as "nothing available" instead
        # of a 500 (e.g. the brief window after deploy, before the migration runs).
        msg = str(exc).lower()
        if "no files found" in msg or "no files matched" in msg:
            return {"engine": "duckdb", "states": {}}
        raise HTTPException(status_code=500, detail=f"availability query failed: {exc}")
    return {"engine": "duckdb", "states": dict(sorted(states.items())), "gsd": gsd, "extent": extent}


def _lake_read_path(collection: str, safe_region: str | None, year: int | None) -> str:
    """Build the narrowest read_parquet glob for the requested partition(s).

    The lake is Hive-partitioned collection=<c>/region=<r>/year=<y>/. Scoping
    the glob to the known partition prefix means the S3 LIST that read_parquet
    issues only enumerates that subtree, instead of listing the entire lake on
    every /search (the dominant cold-read cost over s3://). Hive WHERE-pruning
    still prunes partitions, but only AFTER the LIST -- so the path scope is the
    real lever at CONUS scale. Always scoped under collection= so leftover
    pre-Phase-3 state=* dirs are never read."""
    base = f"{LAKE_ROOT}/collection={collection}"
    if safe_region and year is not None:
        return f"{base}/region={safe_region}/year={year}/**/*.parquet"
    if safe_region:
        return f"{base}/region={safe_region}/**/*.parquet"
    if year is not None:
        # region is the first level under collection, so a year-only scope still
        # globs across region dirs, but restricts to the matching year subtree.
        return f"{base}/*/year={year}/**/*.parquet"
    return f"{base}/**/*.parquet"


def _build_lake_inner_sql(body: dict[str, Any]) -> str:
    """Build the GeoParquet lake read query for /search. Every interpolated value
    is sanitized because DuckDB takes a SQL literal here, not bind params."""
    # collection: accept the request's collection (sanitized), default to naip.
    # A single value drives both the partition scope and the WHERE prune.
    requested = body.get("collections", [COLLECTION_ID])
    collection = (requested[0] if isinstance(requested, list) and requested else COLLECTION_ID)
    collection = "".join(ch for ch in str(collection).lower() if ch.isalnum() or ch in "-_") or COLLECTION_ID

    bbox = body.get("bbox")
    if not bbox or len(bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox is required and must be [minx, miny, maxx, maxy]")

    try:
        xmin, ymin, xmax, ymax = (float(v) for v in bbox)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="bbox values must be numeric")
    limit = min(int(body.get("limit", 1000)), 10000)

    filters = [
        f"bbox_xmin <= {xmax} and bbox_xmax >= {xmin}",
        f"bbox_ymin <= {ymax} and bbox_ymax >= {ymin}",
        f"ST_Intersects(geometry, ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax}))",
    ]
    filters.append(f"collection = '{collection}'")
    # year (request key stays naip:year for viewer back-compat) -> the `year` col
    year = body.get("year", body.get("naip:year"))
    year_int = int(year) if year is not None else None

    # region (request key stays naip:state for viewer back-compat) -> `region` col
    safe_region = None
    region = body.get("region", body.get("naip:state"))
    if region is not None:
        safe_region = "".join(ch for ch in str(region).lower() if ch.isalnum()) or None

    # Scope the read to the requested partition prefix so read_parquet's S3 LIST
    # only walks that subtree. The WHERE clause keeps collection/region/year as a
    # second prune; redundant (but cheap) when the path is already scoped.
    read_path = _lake_read_path(collection, safe_region, year_int)

    if year_int is not None:
        filters.append(f"year = {year_int}")
    else:
        # If no year constraint was requested ("Latest available"), filter to only
        # return the most recent year for each state/region in the query scope.
        filters.append(f"""
            (region, year) in (
                select region, max(year)
                from read_parquet('{read_path}', hive_partitioning=true)
                group by region
            )
        """)

    if safe_region:
        filters.append(f"region = '{safe_region}'")

    # Column order matches make_stac_feature().
    return f"""
      select
        source_bucket, source_key,
        ST_AsGeoJSON(geometry) as geom_json,
        bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
        acquisition_date, gsd, collection, region, year, properties,
        proj_epsg, proj_shape, proj_transform,
        asset_href
      from read_parquet('{read_path}', hive_partitioning=true)
      where {' and '.join(filters)}
      order by year desc, acquisition_date desc nulls last,
               gsd asc nulls last, source_key asc
      limit {limit}
    """


def _finalize_lake_result(rows, response, request_started_at, sql_seconds, engine_label):
    """Shared post-query path for both lake engines: build features, sign URLs,
    set timing headers, return the FeatureCollection."""
    features = [make_stac_feature(row) for row in rows]
    result = {'type': 'FeatureCollection', 'features': features, 'links': []}

    rewrite_stats: dict[str, float | int] = {
        "presign_seconds": 0.0,
        "presign_cache_hits": 0,
        "presign_cache_misses": 0,
    }
    rewrite_started_at = monotonic()
    if SEARCH_SIGN_ASSETS:
        signed_hrefs = prepare_signed_hrefs(features, stats=rewrite_stats)
        result["features"] = [rewrite_feature_assets(feature, signed_hrefs=signed_hrefs) for feature in features]
    else:
        # Decoupled path: leave the raw s3:// href in place (the viewer signs it
        # on demand via /sign) and just strip the metadata asset. No batch signing
        # here, so the response returns at ~sql time and footprints draw at once.
        result["features"] = [rewrite_feature_assets(feature, signed_hrefs=None) for feature in features]
    rewrite_seconds = monotonic() - rewrite_started_at

    total_seconds = monotonic() - request_started_at
    response.headers["x-search-feature-count"] = str(len(features))
    response.headers["x-search-sql-ms"] = f"{sql_seconds * 1000:.1f}"
    response.headers["x-search-sign-ms"] = f"{float(rewrite_stats['presign_seconds']) * 1000:.1f}"
    response.headers["x-search-rewrite-ms"] = f"{rewrite_seconds * 1000:.1f}"
    response.headers["x-search-total-ms"] = f"{total_seconds * 1000:.1f}"
    response.headers["x-search-engine"] = engine_label
    return result


@app.get("/sign")
def sign(href: str):
    """Sign a single s3:// asset href on demand. The viewer calls this lazily
    from deck.gl's getSource as each COG tile is actually loaded, so /search can
    return fast with raw s3:// hrefs and only on-screen tiles ever get signed.
    Shares the same presign cache as the (now-optional) inline search signing, so
    repeat requests for the same key are ~free. Returns expires_in so the client
    can cache the signed URL until just before it lapses."""
    _validate_signable_s3_href(href)
    signed, _headers, expires_in = maybe_sign_s3_href(href)
    # Real (token-bounded) remaining validity, so the viewer's signedUrlCache
    # re-signs before the short-lived STS token dies instead of trusting a fixed
    # PRESIGN_EXPIRES it would cache for an hour.
    return {"href": href, "signed": signed, "expires_in": expires_in if SIGN_ASSET_URLS else 0}


class DetectRequest(BaseModel):
    bbox: list[float]
    concept: str
    score_thresh: float = 0.5
    collection: str = "naip"
    region: str | None = None
    year: int | None = None
    # Ground size (meters) of the detection area. None/small -> a single native
    # 1008px chip (best for small objects: cars, pools). A larger value, when a
    # warm worker is configured, is covered by a grid of native 1008px tiles
    # (no decimation -- full small-object detail everywhere), each run through
    # SAM 3 and stitched in world space. Without a warm worker, a large chip_m
    # falls back to one decimated <=2016px read (coarser, but no tiling fan-out).
    chip_m: float | None = None
    # Tile overlap in native pixels (warm-worker tiling only). Adjacent tiles
    # overlap this much so an object on a seam still lands whole in >=1 tile;
    # size it to the largest expected object (~84px/25m small building,
    # ~252px/75m big-box at 0.3m GSD). None -> DEFAULT_TILE_OVERLAP_PX.
    overlap_px: int | None = None


def color_for_concept(concept: str) -> str:
    h = 0
    for ch in (concept or "x"):
        h = (h * 31 + ord(ch)) % 360
    return f"hsl({h}, 80%, 55%)"


def _tile_grid_origins(center_col, center_row, target_px, tile_px, overlap_px):
    """Top-left (col, row) pixel of each native tile covering a target_px-square
    area centered on (center_col, center_row), with overlap_px shared between
    neighbors. n_side tiles per axis; stride = tile_px - overlap_px. A target
    that fits in one tile yields a single tile centered on the click (so small
    chips reproduce the non-tiled path exactly). Pure integer math -- unit-test
    without rasterio."""
    stride = max(1, tile_px - overlap_px)
    if target_px <= tile_px:
        n = 1
    else:
        n = (target_px - tile_px + stride - 1) // stride + 1  # ceil division
    span = (n - 1) * stride + tile_px
    start_col = center_col - span // 2
    start_row = center_row - span // 2
    origins = [
        (start_col + i * stride, start_row + j * stride)
        for j in range(n) for i in range(n)
    ]
    return origins, n


# --- Concept-aware regularization: square building footprints to their dominant
# angle (the mask outline is faithful but organic; built structures read better
# orthogonalized). Pure-python except the final rotate, which lazy-imports
# shapely so the read-only Lambda (no shapely) is unaffected. ---
_BUILDING_CONCEPTS = ("building", "rooftop", "roof", "house", "warehouse",
                      "shed", "barn", "garage", "hangar", "structure", "hall")


def _is_building_concept(concept: str) -> bool:
    c = (concept or "").lower()
    return any(k in c for k in _BUILDING_CONCEPTS)


def _dominant_angle(coords) -> float:
    """Length-weighted circular mean of edge angles folded to [0, 90deg)."""
    import math
    sx = sy = 0.0
    for (x0, y0), (x1, y1) in zip(coords, coords[1:]):
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        if L < 1e-9:
            continue
        a4 = 4 * math.atan2(dy, dx)   # period pi/2 -> map onto the full circle
        sx += L * math.cos(a4); sy += L * math.sin(a4)
    if sx == 0 and sy == 0:
        return 0.0
    return math.degrees(math.atan2(sy, sx) / 4.0)


def _snap_rectilinear(coords):
    """Open ring (~axis-aligned) -> orthogonal ring. Merge same-orientation edge
    runs into alternating H/V segments, give each a constant coordinate, and
    reconstruct vertices. None if it isn't cleanly rectilinear (caller falls
    back to the organic outline). Preserves L/T shapes, not just boxes."""
    n = len(coords)
    if n < 4:
        return None
    edges = []
    for i in range(n):
        x0, y0 = coords[i]; x1, y1 = coords[(i + 1) % n]
        edges.append("H" if abs(x1 - x0) >= abs(y1 - y0) else "V")
    start = 0
    for k in range(n):
        if edges[k] != edges[(k - 1) % n]:
            start = k; break
    order = [(start + k) % n for k in range(n)]
    segs = []
    cur = edges[order[0]]; members = []
    for idx in order:
        if edges[idx] == cur:
            members.append(idx)
        else:
            segs.append((cur, members)); cur = edges[idx]; members = [idx]
    segs.append((cur, members))
    m = len(segs)
    if m < 4 or m % 2 != 0:
        return None
    if any(segs[i][0] == segs[(i + 1) % m][0] for i in range(m)):
        return None
    consts = []
    for cls, members in segs:
        vs = [coords[k] for k in members] + [coords[(members[-1] + 1) % n]]
        if cls == "H":
            consts.append(("H", sum(v[1] for v in vs) / len(vs)))
        else:
            consts.append(("V", sum(v[0] for v in vs) / len(vs)))
    out = []
    for i in range(m):
        prev_cls, prev_c = consts[i - 1]
        cls, c = consts[i]
        out.append((c, prev_c) if (prev_cls == "H" and cls == "V") else (prev_c, c))
    return out


def regularize_building(geom):
    """Orthogonalize a building footprint to its dominant angle. Returns
    (geom, regularized_bool); on any failure or implausible area change, returns
    the input unchanged so a complex roofline stays faithful rather than mangled."""
    from shapely import affinity
    from shapely.geometry import Polygon
    if geom.geom_type != "Polygon" or len(geom.exterior.coords) < 5:
        return geom, False
    cen = geom.centroid
    theta = _dominant_angle(list(geom.exterior.coords))
    rot = affinity.rotate(geom, -theta, origin=cen)
    snapped = _snap_rectilinear(list(rot.exterior.coords)[:-1])
    if not snapped:
        return geom, False
    try:
        poly = affinity.rotate(Polygon(snapped), theta, origin=cen)
    except Exception:
        return geom, False
    if poly.is_empty or not poly.is_valid or not (0.6 < poly.area / geom.area < 1.6):
        return geom, False
    return poly, True


@app.post("/detect")
def detect_endpoint(req: DetectRequest):
    """Run SAM 3 segmentation on a cropped imagery chip.
    Queries DuckDB to find the covering COG and range-reads native 1008px chips:
    one window for a small chip_m, or (with a warm worker) a grid of overlapping
    1008px tiles for a large chip_m -- full small-object detail everywhere
    instead of one decimated read. SAM 3 runs via the warm worker (SAM3_WORKER_URL,
    one /infer_batch for the grid) if configured, else a cold per-call subprocess
    (SAM3_PYTHON/SAM3_SCRIPT). Each tile's masks reproject through its own
    transform; the pooled detections are deduped in world space (greedy NMS,
    collapsing both synonym hits and tile-seam duplicates) and returned as an
    EPSG:4326 GeoJSON FeatureCollection."""
    # Warm worker takes precedence: a single long-lived process holds the model,
    # so we skip the subprocess-runner config check entirely when it is set.
    sam3_python = Path(SAM3_PYTHON).expanduser() if SAM3_PYTHON else None
    sam3_script = Path(SAM3_SCRIPT).expanduser() if SAM3_SCRIPT else None
    if not SAM3_WORKER_URL:
        if not sam3_python or not sam3_script:
            raise HTTPException(
                status_code=503,
                detail="Synchronous detection is not configured. Set SAM3_WORKER_URL, or SAM3_PYTHON and SAM3_SCRIPT.",
            )
        if not sam3_python.is_file() or not sam3_script.is_file():
            raise HTTPException(
                status_code=503,
                detail=(
                    "Synchronous detection runner is unavailable. "
                    f"SAM3_PYTHON={sam3_python} SAM3_SCRIPT={sam3_script}"
                ),
            )

    # 1. Determine center point
    lon = (req.bbox[0] + req.bbox[2]) / 2.0
    lat = (req.bbox[1] + req.bbox[3]) / 2.0

    # 2. Pick covering COG using in-process DuckDB
    safe_region = "".join(c for c in req.region.lower() if c.isalnum()) if req.region else None
    base = f"{LAKE_ROOT}/collection={req.collection}"
    if safe_region and req.year:
        glob = f"{base}/region={safe_region}/year={req.year}/**/*.parquet"
    elif safe_region:
        glob = f"{base}/region={safe_region}/**/*.parquet"
    elif req.year:
        glob = f"{base}/*/year={req.year}/**/*.parquet"
    else:
        glob = f"{base}/**/*.parquet"

    filters = [
        f"bbox_xmin <= {lon} and bbox_xmax >= {lon}",
        f"bbox_ymin <= {lat} and bbox_ymax >= {lat}",
        f"ST_Intersects(geometry, ST_Point({lon}, {lat}))",
    ]
    if req.year:
        filters.append(f"year = {req.year}")
    if safe_region:
        filters.append(f"region = '{safe_region}'")

    sql = f"""
        select asset_href, source_key, region, year, gsd,
               proj_epsg, proj_shape, proj_transform
        from read_parquet('{glob}', hive_partitioning=true)
        where {' and '.join(filters)}
        order by year desc, gsd asc nulls last, source_key asc
        limit 1
    """
    try:
        # lake_query self-heals an expired S3 token (and refreshes the cached
        # creds the rasterio read below reuses) instead of hard-failing.
        row = lake_query(lambda cur: cur.execute(sql).fetchone())
    except Exception as exc:
        msg = str(exc).lower()
        if "no files found" in msg or "no files matched" in msg:
            row = None
        else:
            raise HTTPException(status_code=500, detail=f"DuckDB search failed: {exc}")

    if not row:
        raise HTTPException(
            status_code=404,
            detail=f"No COG covers center ({lon}, {lat}) for collection={req.collection}"
        )

    asset_href = row[0]
    row_gsd = row[4] if len(row) > 4 and row[4] else None

    # 3. Read window using rasterio
    import rasterio
    from rasterio.env import Env
    from rasterio.warp import transform as warp_transform
    import numpy as np
    from PIL import Image

    creds = get_aws_credentials()
    
    # Generate unique filenames to allow concurrent requests
    chips_dir = MODULE_DIR.parent / "cache" / "chips"
    chips_dir.mkdir(parents=True, exist_ok=True)
    job_id = uuid4().hex
    out_json_path = chips_dir / f"result_{job_id}.json"
    chip_specs = []  # [(chip_path, win_transform), ...] -- one per tile

    try:
        from rasterio.session import AWSSession
        session_kwargs = {}
        if creds.get("aws_access_key_id"):
            session_kwargs["aws_access_key_id"] = creds["aws_access_key_id"]
        if creds.get("aws_secret_access_key"):
            session_kwargs["aws_secret_access_key"] = creds["aws_secret_access_key"]
        if creds.get("aws_session_token"):
            session_kwargs["aws_session_token"] = creds["aws_session_token"]
        session_kwargs["region_name"] = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-west-2")
        
        session = AWSSession(**session_kwargs)
        with Env(
            session=session,
            AWS_REQUEST_PAYER="requester",
            GDAL_DISABLE_READDIR_ON_OPEN="YES",
        ):
            vsi = "/vsis3/" + asset_href[len("s3://"):]
            with rasterio.open(vsi) as src:
                xs, ys = warp_transform("EPSG:4326", src.crs, [lon], [lat])
                row_idx, col_idx = src.index(xs[0], ys[0])
                gsd_native = float(row_gsd) if row_gsd else abs(src.transform.a)
                src_crs = src.crs
                src_transform = src.transform
                src_w, src_h = src.width, src.height

                MAX_READ_PX = 2016
                chip_m = min(float(req.chip_m), 5000.0) if (req.chip_m and req.chip_m > 0) else 0.0
                target_px = int(round(chip_m / gsd_native)) if chip_m else 0
                overlap_px = req.overlap_px if req.overlap_px is not None else DEFAULT_TILE_OVERLAP_PX
                overlap_px = max(0, min(int(overlap_px), TILE_PX - 1))

                # Tiling needs the warm batch path: a large chip_m is covered by a
                # grid of native 1008px tiles (full detail everywhere). Without a
                # worker -- or for a chip that fits one tile -- read a single
                # window (decimated to <=MAX_READ_PX for big no-worker chips).
                if SAM3_WORKER_URL and target_px > TILE_PX:
                    origins, _ = _tile_grid_origins(col_idx, row_idx, target_px, TILE_PX, overlap_px)
                    if len(origins) > MAX_TILES:
                        stride_m = (TILE_PX - overlap_px) * gsd_native
                        max_m = int(TILE_PX * gsd_native + (int(MAX_TILES ** 0.5) - 1) * stride_m)
                        raise HTTPException(
                            status_code=413,
                            detail=(f"Tiled detection needs {len(origins)} tiles "
                                    f"(> MAX_TILES={MAX_TILES}). Reduce chip_m to "
                                    f"~{max_m}m or raise MAX_TILES."),
                        )
                    effective_gsd = gsd_native  # native everywhere; no decimation
                    for (c0, r0) in origins:
                        # Skip tiles entirely outside the COG footprint (all nodata).
                        if c0 + TILE_PX <= 0 or r0 + TILE_PX <= 0 or c0 >= src_w or r0 >= src_h:
                            continue
                        win = rasterio.windows.Window(c0, r0, TILE_PX, TILE_PX)
                        arr = src.read([1, 2, 3], window=win, boundless=True, fill_value=0)
                        if not arr.any():
                            continue  # window landed on a fully nodata patch
                        wt = rasterio.windows.transform(win, src_transform)
                        cp = chips_dir / f"chip_{job_id}_{len(chip_specs)}.png"
                        Image.fromarray(np.transpose(arr, (1, 2, 0))).save(cp)
                        chip_specs.append((cp, wt))
                    if not chip_specs:
                        raise HTTPException(
                            status_code=404,
                            detail="Detection area falls entirely outside the COG footprint.",
                        )
                else:
                    # Single window. Native 1008px for a small chip (best for small
                    # objects); a big no-worker chip_m decimates to <=MAX_READ_PX
                    # via overviews (SAM downsamples to 1008 anyway).
                    native_px = max(TILE_PX, target_px) if target_px > TILE_PX else TILE_PX
                    read_px = min(native_px, MAX_READ_PX)
                    half = native_px // 2
                    win = rasterio.windows.Window(col_idx - half, row_idx - half, native_px, native_px)
                    arr = src.read([1, 2, 3], window=win, boundless=True, fill_value=0,
                                   out_shape=(3, read_px, read_px))
                    scale = native_px / read_px
                    wt = rasterio.windows.transform(win, src_transform) * rasterio.Affine.scale(scale)
                    effective_gsd = gsd_native * scale
                    cp = chips_dir / f"chip_{job_id}_0.png"
                    Image.fromarray(np.transpose(arr, (1, 2, 0))).save(cp)
                    chip_specs.append((cp, wt))

        # 4. Run SAM 3 -- warm worker (one /infer per chip, or one /infer_batch
        # for a tile grid) if configured, else cold subprocess (single chip).
        # Every path yields the same per-instance JSON shape, so the vectorize/
        # dedup code below is identical. tile_results pairs each result with the
        # transform of the tile it came from (so masks reproject correctly).
        tile_results = []  # [(result_data, win_transform), ...]
        if SAM3_WORKER_URL:
            import urllib.error
            import urllib.request

            def _worker_post(path, body):
                wreq = urllib.request.Request(
                    f"{SAM3_WORKER_URL}{path}", data=json.dumps(body).encode(),
                    headers={"Content-Type": "application/json"},
                )
                try:
                    with urllib.request.urlopen(wreq, timeout=SAM3_TIMEOUT_SECONDS) as resp:
                        return json.loads(resp.read())
                except urllib.error.HTTPError as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"SAM 3 warm worker error ({exc.code}): {exc.read().decode(errors='replace')}",
                    ) from exc
                except (urllib.error.URLError, TimeoutError) as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"SAM 3 warm worker unreachable at {SAM3_WORKER_URL}: {exc}",
                    ) from exc

            common = {"prompt": req.concept, "score_thresh": req.score_thresh, "masks": True}
            if len(chip_specs) == 1:
                rd = _worker_post("/infer", {"chip": str(chip_specs[0][0]), **common})
                tile_results.append((rd, chip_specs[0][1]))
            else:
                batch = _worker_post("/infer_batch", {"chips": [str(cp) for cp, _ in chip_specs], **common})
                results = batch.get("results", [])
                if len(results) != len(chip_specs):
                    raise HTTPException(
                        status_code=502,
                        detail=f"Warm worker returned {len(results)} results for {len(chip_specs)} chips.",
                    )
                for (cp, wt), rd in zip(chip_specs, results):
                    tile_results.append((rd, wt))
        else:
            # Cold subprocess fallback: a fresh process (pays the model load).
            # Tiling is gated on the worker, so there is exactly one chip here.
            cp, wt = chip_specs[0]
            cmd = [
                str(sam3_python),
                str(sam3_script),
                "--chip", str(cp),
                "--prompt", req.concept,
                "--score-thresh", str(req.score_thresh),
                "--out", str(out_json_path),
                "--masks",  # emit a binary mask RLE per instance for polygonization
            ]

            env = os.environ.copy()
            env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

            try:
                res = subprocess.run(
                    cmd,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=SAM3_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired as exc:
                raise HTTPException(
                    status_code=504,
                    detail=f"SAM 3 inference exceeded {SAM3_TIMEOUT_SECONDS} seconds.",
                ) from exc
            if res.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"SAM 3 inference subprocess failed with code {res.returncode}. Stderr: {res.stderr}"
                )

            # Read results written by the subprocess.
            if not out_json_path.exists():
                raise HTTPException(
                    status_code=500,
                    detail="SAM 3 inference completed but output JSON was not written."
                )

            with open(out_json_path, "r") as f:
                tile_results.append((json.load(f), wt))

        features = []

        # Vectorize each instance's SAM mask into a generalized polygon. The mask
        # grid == its tile's 1008px window, so that tile's win_transform maps it
        # straight to the COG CRS; simplification runs there (meters) before
        # reprojecting to 4326. Instances without a mask fall back to the bbox.
        import numpy as np
        import rasterio.features
        from shapely.geometry import shape as shapely_shape, box as shapely_box
        from shapely.ops import transform as shapely_transform
        from pyproj import Transformer

        to_4326 = Transformer.from_crs(src_crs, "EPSG:4326", always_xy=True).transform
        gsd_m = effective_gsd                 # read-grid resolution (native when tiled)
        simplify_tol = 1.5 * gsd_m            # ~1.5 px: de-stair without distorting
        min_area_m2 = (4 * gsd_m) ** 2        # drop specks/holes below ~4px square

        def _mask_polygon(rle, win_transform):
            counts = rle.get("counts") or []
            h, w = rle.get("size", [0, 0])
            if not counts or h * w == 0:
                return None
            vals = np.zeros(sum(counts), dtype=np.uint8)
            pos, bit = 0, 0
            for c in counts:
                if bit:
                    vals[pos:pos + c] = 1
                pos += c
                bit ^= 1
            mask = vals.reshape(h, w)
            if not mask.any():
                return None
            # shapes() with transform= returns rings already in the COG CRS.
            polys = [
                shapely_shape(geom)
                for geom, val in rasterio.features.shapes(
                    mask, mask=mask.astype(bool), transform=win_transform)
                if val == 1
            ]
            polys = [p for p in polys if p.area >= min_area_m2]
            if not polys:
                return None
            geom = max(polys, key=lambda p: p.area).simplify(simplify_tol, preserve_topology=True)
            return geom if not geom.is_empty else None

        # Gather candidates across every tile and every concept into one pool.
        # Tiling (synonyms via multi-prompt union, plus the same physical object
        # seen in adjacent tiles' overlap) all collapses in the shared world-space
        # dedup below. Each tile's instances reproject with its own transform.
        candidates = []  # (geom_crs, score, concept, regularized)
        for result_data, win_transform in tile_results:
            concept_results = result_data.get("concepts")
            if not concept_results:  # back-compat with single-concept output
                concept_results = [{
                    "concept": result_data.get("concept", req.concept),
                    "instances": result_data.get("instances", []),
                }]
            for cres in concept_results:
                concept = cres.get("concept", req.concept)
                regularize = _is_building_concept(concept)
                for inst in cres.get("instances", []):
                    geom_crs = _mask_polygon(inst["mask_rle"], win_transform) if inst.get("mask_rle") else None
                    from_bbox = geom_crs is None
                    if from_bbox:
                        x0, y0, x1, y1 = inst["bbox_px"]
                        (X0, Y1), (X1, Y0) = win_transform * (x0, y0), win_transform * (x1, y1)
                        geom_crs = shapely_box(min(X0, X1), min(Y0, Y1), max(X0, X1), max(Y0, Y1))
                    regularized = False
                    if regularize and not from_bbox:
                        geom_crs, regularized = regularize_building(geom_crs)
                    candidates.append((geom_crs, float(inst["score"]), concept, regularized))

        # World-space dedup: greedy NMS by score; a candidate is dropped if it
        # overlaps an already-kept one by IoU > 0.5 (the same building found by
        # both "building" and "rooftop", or the same object straddling a tile
        # seam and caught in two tiles). bbox quick-reject keeps it cheap.
        candidates.sort(key=lambda c: c[1], reverse=True)
        kept = []
        for geom_crs, score, concept, regularized in candidates:
            b = geom_crs.bounds
            dup = False
            for kg, *_ in kept:
                kb = kg.bounds
                if b[2] < kb[0] or b[0] > kb[2] or b[3] < kb[1] or b[1] > kb[3]:
                    continue
                inter = geom_crs.intersection(kg).area
                if inter and inter / (geom_crs.area + kg.area - inter) > 0.5:
                    dup = True
                    break
            if not dup:
                kept.append((geom_crs, score, concept, regularized))

        for geom_crs, score, concept, regularized in kept:
            geom_4326 = shapely_transform(to_4326, geom_crs)
            features.append({
                "type": "Feature",
                "properties": {
                    "color": color_for_concept(concept),
                    "concept": concept,
                    "score": round(score, 4),
                    "area_m2": round(geom_crs.area, 1),
                    "regularized": regularized,
                },
                "geometry": geom_4326.__geo_interface__,
            })

        return {
            "type": "FeatureCollection",
            "features": features
        }

    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")
        
    finally:
        # Clean up temporary files (one chip per tile, plus the subprocess JSON).
        for cp, _ in chip_specs:
            if cp.exists():
                try:
                    cp.unlink()
                except Exception:
                    pass
        if out_json_path.exists():
            try:
                out_json_path.unlink()
            except Exception:
                pass


@app.post("/search")
def search(body: dict[str, Any], response: Response):
    """The read path: a standalone in-process DuckDB connection (get_lake_duckdb)
    reads the GeoParquet lake directly (read_parquet, bbox-column pruning,
    ST_Intersects refine) -- no database server. This is the Lambda read profile.
    Returns a STAC FeatureCollection with the same shape the viewer expects."""
    request_started_at = monotonic()
    inner = _build_lake_inner_sql(body)

    sql_started_at = monotonic()
    try:
        rows = lake_query(lambda cur: cur.execute(inner).fetchall())
    except Exception as exc:
        # A partition-scoped read_parquet glob (collection=/region=/year=) that
        # matches no files raises an IO error rather than returning empty. For a
        # search over an absent region/year combo that's just "no results", not a 500.
        msg = str(exc).lower()
        if "no files found" in msg or "no files matched" in msg:
            rows = []
        else:
            raise
    sql_seconds = monotonic() - sql_started_at

    return _finalize_lake_result(rows, response, request_started_at, sql_seconds, "duckdb-direct-lake")


def _embed_read_path(collection: str, safe_region: str | None, year: int | None) -> str:
    """Narrowest read_parquet glob for the embedding lake. Same rationale as
    _lake_read_path: scoping the glob to the known partition prefix keeps the
    S3 LIST to that subtree. The embedding lake stores one file per 1-degree
    block directly under year=."""
    base = f"{EMBED_LAKE_ROOT}/collection={collection}"
    if safe_region and year is not None:
        return f"{base}/region={safe_region}/year={year}/*.parquet"
    if safe_region:
        return f"{base}/region={safe_region}/**/*.parquet"
    if year is not None:
        return f"{base}/*/year={year}/*.parquet"
    return f"{base}/**/*.parquet"


def make_similar_feature(row, collection: str) -> dict[str, Any]:
    (naip_item, block, geom_json, xmin, ymin, xmax, ymax,
     naip_date, gsd, src_uri, region, year, sim) = row
    geometry = json.loads(geom_json) if isinstance(geom_json, str) else geom_json
    props = {
        'sim': round(float(sim), 4),
        'naip_item': naip_item,
        'block': block,
        'datetime': f"{naip_date.isoformat()}T00:00:00Z" if naip_date else None,
        'gsd': gsd,
        'region': region,
        'year': year,
    }
    return {
        'type': 'Feature',
        'id': f"{naip_item}/{xmin:.6f},{ymin:.6f}",
        'collection': collection,
        'geometry': geometry,
        'bbox': [xmin, ymin, xmax, ymax],
        'properties': {k: v for k, v in props.items() if v is not None},
        'assets': {
            'source_image': {
                'href': src_uri,
                'type': 'image/tiff; application=geotiff; profile=cloud-optimized',
                'roles': ['data'],
            }
        },
    }


@app.post("/similar")
def similar(body: dict[str, Any], response: Response):
    """Stage-0 semantic retrieval over the embedding lake: take the chip
    covering a query point, rank every chip in the scoped partition by cosine
    similarity to it, return the top K as chip-footprint features. Brute-force
    DuckDB scan (~1 GB per RI-sized state-year) -- no vector index, no GPU.
    The query chip itself is echoed under `query` and excluded from results."""
    request_started_at = monotonic()

    try:
        lon = float(body["lon"])
        lat = float(body["lat"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="lon and lat are required and must be numeric")

    collection = body.get("collection", EMBED_COLLECTION_ID)
    collection = "".join(ch for ch in str(collection).lower() if ch.isalnum() or ch in "-_") or EMBED_COLLECTION_ID

    safe_region = None
    region = body.get("region")
    if region is not None:
        safe_region = "".join(ch for ch in str(region).lower() if ch.isalnum()) or None

    year = body.get("year")
    try:
        year_int = int(year) if year is not None else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="year must be an integer")

    try:
        k = max(1, min(int(body.get("k", 25)), 500))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="k must be an integer")

    read_path = _embed_read_path(collection, safe_region, year_int)
    point_filter = (
        f"bbox_xmin <= {lon} and bbox_xmax >= {lon} "
        f"and bbox_ymin <= {lat} and bbox_ymax >= {lat}"
    )
    # Newest chip covering the point is the query vector; ties broken by item
    # for determinism. Hive columns (region/year) survive the scoped glob.
    query_chip_sql = f"""
      select naip_item, block, bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
             naip_date, gsd, region, year
      from read_parquet('{read_path}', hive_partitioning=true)
      where {point_filter}
      order by year desc, naip_date desc, naip_item asc
      limit 1
    """

    sql_started_at = monotonic()
    try:
        chip = lake_query(lambda cur: cur.execute(query_chip_sql).fetchone())
    except Exception as exc:
        msg = str(exc).lower()
        if "no files found" in msg or "no files matched" in msg:
            raise HTTPException(status_code=404, detail=f"no embeddings harvested for {read_path}")
        raise
    if chip is None:
        raise HTTPException(status_code=404, detail="no embedding chip covers that point in the requested scope")
    (q_item, q_block, q_xmin, q_ymin, q_xmax, q_ymax, q_date, q_gsd, q_region, q_year) = chip

    knn_sql = f"""
      with q as (
        select embedding::FLOAT[{EMBED_DIM}] as qe
        from read_parquet('{read_path}', hive_partitioning=true)
        where {point_filter}
        order by year desc, naip_date desc, naip_item asc
        limit 1
      )
      select t.naip_item, t.block, ST_AsGeoJSON(t.geometry) as geom_json,
             t.bbox_xmin, t.bbox_ymin, t.bbox_xmax, t.bbox_ymax,
             t.naip_date, t.gsd, t.src_uri, t.region, t.year,
             array_cosine_similarity(t.embedding::FLOAT[{EMBED_DIM}], q.qe) as sim
      from read_parquet('{read_path}', hive_partitioning=true) t, q
      where not (t.naip_item = '{q_item}'
                 and t.bbox_xmin = {q_xmin} and t.bbox_ymin = {q_ymin})
      order by sim desc
      limit {k}
    """
    rows = lake_query(lambda cur: cur.execute(knn_sql).fetchall())
    sql_seconds = monotonic() - sql_started_at

    features = [make_similar_feature(row, collection) for row in rows]
    result = {
        'type': 'FeatureCollection',
        'features': features,
        'query': {
            'lon': lon, 'lat': lat, 'k': k, 'collection': collection,
            'chip': {
                'naip_item': q_item,
                'block': q_block,
                'bbox': [q_xmin, q_ymin, q_xmax, q_ymax],
                'datetime': f"{q_date.isoformat()}T00:00:00Z" if q_date else None,
                'gsd': q_gsd,
                'region': q_region,
                'year': q_year,
            },
        },
        'links': [],
    }
    total_seconds = monotonic() - request_started_at
    response.headers["x-similar-feature-count"] = str(len(features))
    response.headers["x-similar-sql-ms"] = f"{sql_seconds * 1000:.1f}"
    response.headers["x-similar-total-ms"] = f"{total_seconds * 1000:.1f}"
    return result


# AWS Lambda entry point. Mangum adapts the ASGI app to the Lambda event/response
# shape (works behind a Function URL or API Gateway). It is only needed on
# Lambda; locally and in docker we run `uvicorn app:app` and never import it, so
# the dependency stays optional and a missing mangum never breaks dev.
try:
    from mangum import Mangum

    handler = Mangum(app)
except ImportError:  # mangum not installed (local/docker) -- no Lambda handler
    handler = None
