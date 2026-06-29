import os
import json
import subprocess
import urllib.error
import urllib.request

import s1m

from pathlib import Path
from secrets import compare_digest
from threading import Thread
from time import monotonic
from typing import Any
from uuid import uuid4

from pydantic import BaseModel
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from aws_s3 import (
    get_aws_credentials,
    maybe_sign_s3_href,
    prepare_signed_hrefs,
    rewrite_feature_assets,
    reset_aws_credentials_cache,
    validate_signable_s3_href,
)
from config import (
    COLLECTION_ID,
    DEFAULT_TILE_OVERLAP_PX,
    EMBED_COLLECTION_ID,
    EMBED_DIM,
    EMBED_LAKE_ROOT,
    INGEST_MODE,
    INGEST_TOKEN,
    LAKE_ROOT,
    LOCAL_MODULE_DIRS,
    MAX_TILES,
    MODULE_DIR,
    OVERTURE_BUILDINGS_INDEX,
    OVERTURE_BUILDINGS_PARQUET,
    OVERTURE_SOURCE_REGION,
    PRESIGN_EXPIRES,
    SAM3_PYTHON,
    SAM3_SCRIPT,
    SAM3_TIMEOUT_SECONDS,
    SAM3_WORKER_URL,
    SEARCH_SIGN_ASSETS,
    SIGN_ASSET_URLS,
    SYNC_INGEST_DEFAULT_LIMIT,
    SYNC_INGEST_MAX_LIMIT,
    TILE_PX,
    VIEWER_DIR,
)
from duckdb_s3 import load_extensions
from ingest_options import build_ingest_options
from ingest_jobs import get_ingest_job, run_ingest_job, set_ingest_job
from lake import get_lake_duckdb, is_expired_token_error, lake_collections, reset_lake_duckdb
from probes import build_environment_payload

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

@app.on_event("startup")
def startup_event():
    import descriptors
    descriptors.register_lake_collections()

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

@app.get("/health")
def health():
    get_lake_duckdb().cursor().execute("select 1").fetchone()
    return {"ok": True}


def lake_query(run, *, retried: bool = False):
    """Compatibility wrapper for route/test surfaces that patch app.get_lake_duckdb."""
    try:
        return run(get_lake_duckdb().cursor())
    except Exception as exc:
        if retried or not is_expired_token_error(exc):
            raise
        reset_lake_duckdb()
        reset_aws_credentials_cache()
        return lake_query(run, retried=True)


@app.get("/environment")
def environment():
    return build_environment_payload()


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


@app.get("/collections")
def collections():
    try:
        ids = lake_collections() or [COLLECTION_ID]
    except Exception as exc:
        # A failed lake listing (e.g. missing/expired credentials) must NOT be
        # masked as "only the default collection is ingested" -- that silently
        # hides other ingested collections from the viewer. Surface it as a
        # retryable 503 so the client keeps its last-known list and retries.
        raise HTTPException(
            status_code=503, detail=f"lake collection listing failed: {exc}"
        )
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


def require_ingest_token(
    x_ingest_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
):
    if not INGEST_TOKEN:
        if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
            raise HTTPException(status_code=503, detail="ingest token is not configured")
        return

    supplied = x_ingest_token or ""
    if not supplied and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            supplied = value

    if not supplied or not compare_digest(supplied, INGEST_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid or missing ingest token.")


@app.post("/ingest/options")
def ingest_options(body: dict[str, Any]):
    return build_ingest_options(body)


@app.post("/ingest/run")
def ingest_run(body: dict[str, Any], _: None = Depends(require_ingest_token)):
    """Start an ingest as a background job and return a job_id to poll via
    /ingest/status/{job_id}.

    This is the LOCAL/Docker path (config.INGEST_MODE == "async", the default off
    Lambda). The work runs in a background thread tracked in-process, so the HTTP
    response returns immediately and there is no per-request timeout -- large or
    long ingests (many COGs, full years) are fine here, and the panel polls for
    progress.

    On Lambda this path is NOT used: INGEST_MODE is "sync" (set because
    AWS_LAMBDA_FUNCTION_NAME is present), so the viewer calls /ingest/run-sync
    instead. A background thread/subprocess can't outlive the response there --
    Lambda freezes the execution environment once the handler returns and keeps no
    cross-request job state -- so the ingest must run inline within the function's
    invocation timeout. Net effect: locally an ingest can run for minutes via this
    async job; on Lambda it must finish within the (sync) request budget, which is
    why the panel's per-partition cap matters there but not here. The viewer learns
    which path to call from /ingest/options' `ingest_mode`.
    """
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
    
    bucket = body.get("source_bucket")
    prefix = body.get("source_prefix")
    access = body.get("source_access")

    import descriptors
    collection_id = str(body.get("collection") or COLLECTION_ID)
    if bucket:
        try:
            descriptor = descriptors.register_adhoc_collection(
                collection_id=collection_id,
                bucket=bucket,
                prefix=prefix or "",
                region=state,
                year=year,
                access=access or "public",
            )
            collection = descriptor.id
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        try:
            descriptor = descriptors.get_descriptor(collection_id)
            collection = descriptor.id
        except SystemExit as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    # Optional per-partition cap; absent/0 means "all" (CLI default).
    raw_limit = body.get("limit_per_partition")
    try:
        limit_per_partition = int(raw_limit) if raw_limit not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid limit_per_partition")
    if limit_per_partition is not None and limit_per_partition < 0:
        raise HTTPException(status_code=400, detail="limit_per_partition must be >= 0")
    job_id = uuid4().hex
    set_ingest_job(
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
        target=run_ingest_job,
        args=(job_id, state, year, strategy, limit_per_partition, collection),
        kwargs={
            "source_bucket": bucket,
            "source_prefix": prefix,
            "source_access": access,
        },
        daemon=True,
    )
    thread.start()
    return {"job_id": job_id, "status": "running"}


@app.get("/ingest/status/{job_id}")
def ingest_status(job_id: str):
    job = get_ingest_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Ingest job not found")
    return job


@app.post("/ingest/run-sync")
def ingest_run_sync(body: dict[str, Any], _: None = Depends(require_ingest_token)):
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

    bucket = body.get("source_bucket")
    prefix = body.get("source_prefix")
    access = body.get("source_access")

    import descriptors
    collection_id = str(body.get("collection") or COLLECTION_ID)
    if bucket:
        try:
            descriptor = descriptors.register_adhoc_collection(
                collection_id=collection_id,
                bucket=bucket,
                prefix=prefix or "",
                region=state,
                year=year,
                access=access or "public",
            )
            collection = descriptor.id
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        try:
            descriptor = descriptors.get_descriptor(collection_id)
            collection = descriptor.id
        except SystemExit as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    # Lazy import: keep duckdb/ingest off the cold-start path for non-ingest
    # requests (the read API is the common case).
    import ingest_duckdb as ig
    from types import SimpleNamespace

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
        source_bucket=bucket,
        source_prefix=prefix,
        source_access=access,
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
    limit = min(int(body.get("limit", 1000)), 18000)

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

    order_terms = [
        "year desc",
        "acquisition_date desc nulls last",
        "gsd asc nulls last",
        "source_key asc",
    ]

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
      order by {', '.join(order_terms)}
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
    validate_signable_s3_href(href)
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


# --- Map-layer endpoints (re-applied onto the modular API in Phase 2) --------
# /naip-coverage and /buildings/overture are this fork's own endpoints (absent
# from the upstream parent); restored here after Phase 1 modularized app.py.

def _webmercator_tile_bbox_lnglat(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Lon/lat (west, south, east, north) of a WebMercatorQuad z/x/y tile."""
    import math
    n = 2 ** z

    def tile_x_to_lon(tile_x: int) -> float:
        return tile_x / n * 360.0 - 180.0

    def tile_y_to_lat(tile_y: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * tile_y / n))))

    return (tile_x_to_lon(x), tile_y_to_lat(y + 1), tile_x_to_lon(x + 1), tile_y_to_lat(y))


@app.get("/naip-coverage/{z}/{x}/{y}.mvt")
def naip_coverage_mvt(
    z: int,
    x: int,
    y: int,
    collection: str = COLLECTION_ID,
    region: str | None = None,
    year: int | None = None,
):
    """MVT coverage outline layer for NAIP-like COG footprints.

    This is a map-layer transport, not a search result. It emits one source-layer
    named "naip" with compact polygon features and a few small properties.
    """
    if z < 4 or z > 15:
        return Response(content=b"", media_type="application/vnd.mapbox-vector-tile")
    if x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        raise HTTPException(status_code=404, detail="tile outside WebMercatorQuad bounds")

    collection = "".join(ch for ch in str(collection).lower() if ch.isalnum() or ch in "-_") or COLLECTION_ID
    safe_region = "".join(ch for ch in str(region).lower() if ch.isalnum()) if region else None
    year_int = int(year) if year is not None else None
    read_path = _lake_read_path(collection, safe_region, year_int)
    escaped_path = read_path.replace("'", "''")
    west, south, east, north = _webmercator_tile_bbox_lnglat(z, x, y)

    filters = [
        f"bbox_xmin <= {east} and bbox_xmax >= {west}",
        f"bbox_ymin <= {north} and bbox_ymax >= {south}",
        f"collection = '{collection}'",
    ]
    if year_int is not None:
        filters.append(f"year = {year_int}")
    else:
        filters.append(f"""
            (region, year) in (
                select region, max(year)
                from read_parquet('{escaped_path}', hive_partitioning=true)
                group by region
            )
        """)
    if safe_region:
        filters.append(f"region = '{safe_region}'")

    sql = f"""
        with bounds as (
          select ST_Extent(ST_TileEnvelope({z}, {x}, {y})) as b
        ),
        features as (
          select
            ST_AsMVTGeom(
              ST_Transform(
                geometry,
                'EPSG:4326',
                'EPSG:3857',
                true
              ),
              bounds.b,
              4096::BIGINT,
              64::BIGINT,
              true
            ) as geom,
            asset_href as href,
            region,
            year as yr,
            gsd
          from read_parquet('{escaped_path}', hive_partitioning=true), bounds
          where {' and '.join(filters)}
        )
        select ST_AsMVT(features, 'naip', 4096, 'geom')
        from features
        where geom is not null
    """
    try:
        tile = lake_query(lambda cur: cur.execute(sql).fetchone()[0])
    except Exception as exc:
        msg = str(exc).lower()
        if "no files found" in msg or "no files matched" in msg:
            tile = b""
        else:
            raise HTTPException(status_code=500, detail=f"naip coverage mvt failed: {exc}")

    return Response(
        content=tile or b"",
        media_type="application/vnd.mapbox-vector-tile",
        headers={"cache-control": "public, max-age=3600"},
    )


# Columns read from Overture row groups -- geometry + bbox (for the in-memory
# viewport prefilter) + the attributes the viewer's 3D layer renders. Skipping
# the facade_*/roof_* columns keeps each row-group fetch small.
_OVERTURE_READ_COLS = [
    "id", "height", "min_height", "num_floors", "subtype", "class",
    "has_parts", "bbox", "geometry",
]
# A viewport intersecting more row groups than this is too zoomed-out to stream
# cheaply (each row group is ~38k buildings / ~5 MB). The viewer only enables
# buildings in close terrain views, so this is a safety rail, not a normal path.
_OVERTURE_MAX_ROW_GROUPS = 96
# Module-level caches: an anonymous S3 handle, the small CONUS index, and parquet
# footers, so repeated viewports don't re-list S3 or re-read 600 KB footers.
_overture_s3fs = None
_overture_index = None  # (path, list[dict]) -- the loaded row-group index
_overture_pf_cache: dict[str, Any] = {}


def _overture_s3():
    global _overture_s3fs
    if _overture_s3fs is None:
        import pyarrow.fs as pa_fs
        _overture_s3fs = pa_fs.S3FileSystem(region=OVERTURE_SOURCE_REGION, anonymous=True)
    return _overture_s3fs


def _load_overture_index():
    """Load (and cache) the CONUS row-group index. Returns a list of dicts with
    file/row_group/bbox_* keys, or None if the index is unreachable."""
    global _overture_index
    if _overture_index and _overture_index[0] == OVERTURE_BUILDINGS_INDEX:
        return _overture_index[1]
    import pyarrow.parquet as pq
    try:
        if OVERTURE_BUILDINGS_INDEX.startswith("s3://"):
            import pyarrow.fs as pa_fs
            fsys = pa_fs.S3FileSystem(region=OVERTURE_SOURCE_REGION)
            table = pq.read_table(OVERTURE_BUILDINGS_INDEX[5:], filesystem=fsys)
        else:
            if not Path(OVERTURE_BUILDINGS_INDEX).exists():
                return None
            table = pq.read_table(OVERTURE_BUILDINGS_INDEX)
    except Exception as exc:  # noqa: BLE001 -- treated as "index unavailable"
        print(f"Overture buildings index unavailable ({OVERTURE_BUILDINGS_INDEX}): {exc}", flush=True)
        return None
    records = table.to_pylist()
    _overture_index = (OVERTURE_BUILDINGS_INDEX, records)
    return records


def _overture_pf(key: str):
    pf = _overture_pf_cache.get(key)
    if pf is None:
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(key, filesystem=_overture_s3())
        _overture_pf_cache[key] = pf
    return pf


def _parse_viewport_bboxes(body: dict[str, Any]):
    raw_bboxes = body.get("bboxes") or []
    bboxes: list[tuple[float, float, float, float]] = []
    for bbox in raw_bboxes[:32]:
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            west, south, east, north = [float(v) for v in bbox]
        except (TypeError, ValueError):
            continue
        if west >= east or south >= north:
            continue
        bboxes.append((west, south, east, north))
    return bboxes


def _overture_features_from_index(bboxes, limit):
    """Index-pruned, on-demand read: bbox-prune the CONUS row-group index to the
    viewport, fetch only the matching row groups from Overture's public S3, then
    bbox-prefilter + exact-intersect with DuckDB into GeoJSON features."""
    index = _load_overture_index()
    if index is None:
        return None

    # 1. Prune the index to row groups whose extent hits any viewport box.
    by_file: dict[str, set[int]] = {}
    for rec in index:
        rx0, ry0, rx1, ry1 = rec["bbox_xmin"], rec["bbox_ymin"], rec["bbox_xmax"], rec["bbox_ymax"]
        for west, south, east, north in bboxes:
            if rx1 >= west and rx0 <= east and ry1 >= south and ry0 <= north:
                by_file.setdefault(rec["file"], set()).add(rec["row_group"])
                break
    total_rg = sum(len(v) for v in by_file.values())
    if total_rg == 0:
        return {"type": "FeatureCollection", "features": [], "links": [], "limit": limit,
                "bboxes": len(bboxes), "row_groups": 0, "source": "overture-index"}
    if total_rg > _OVERTURE_MAX_ROW_GROUPS:
        raise HTTPException(
            status_code=413,
            detail=(f"viewport spans {total_rg} Overture row groups "
                    f"(max {_OVERTURE_MAX_ROW_GROUPS}); zoom in to load buildings"),
        )

    # 2. Fetch only the matching row groups from Overture's public S3.
    import pyarrow as pa
    import pyarrow.compute as pc
    tables = []
    for key, rgs in by_file.items():
        tables.append(_overture_pf(key).read_row_groups(sorted(rgs), columns=_OVERTURE_READ_COLS))
    table = pa.concat_tables(tables)

    # 3. In-memory bbox prefilter (cheap, no geometry parse) down to ~viewport.
    bx = table.column("bbox")
    bxmin, bymin = pc.struct_field(bx, "xmin"), pc.struct_field(bx, "ymin")
    bxmax, bymax = pc.struct_field(bx, "xmax"), pc.struct_field(bx, "ymax")
    mask = None
    for west, south, east, north in bboxes:
        m = pc.and_(
            pc.and_(pc.greater_equal(bxmax, west), pc.less_equal(bxmin, east)),
            pc.and_(pc.greater_equal(bymax, south), pc.less_equal(bymin, north)),
        )
        mask = m if mask is None else pc.or_(mask, m)
    table = table.filter(mask)
    if table.num_rows == 0:
        return {"type": "FeatureCollection", "features": [], "links": [], "limit": limit,
                "bboxes": len(bboxes), "row_groups": total_rg, "source": "overture-index"}

    # 4. Exact intersect + GeoJSON via DuckDB over the (small) fetched table.
    values_sql = ",\n".join(
        f"({i}, {w:.12f}, {s:.12f}, {e:.12f}, {n:.12f})"
        for i, (w, s, e, n) in enumerate(bboxes)
    )
    import duckdb
    con = duckdb.connect(":memory:")
    try:
        load_extensions(con, spatial=True)
        con.register("hits_arrow", table)
        rows = con.execute(
            f"""
            with boxes(idx, west, south, east, north) as (values {values_sql}),
            parsed as (
              select b.id, b.height, b.min_height, b.num_floors, b.subtype,
                     b.class, b.has_parts,
                     struct_extract(b.bbox, 'xmin') as bxmin,
                     struct_extract(b.bbox, 'ymin') as bymin,
                     struct_extract(b.bbox, 'xmax') as bxmax,
                     struct_extract(b.bbox, 'ymax') as bymax,
                     ST_GeomFromWKB(b.geometry) as geom
              from hits_arrow b
            ),
            joined as (
              select p.*, ST_AsGeoJSON(p.geom) as geom_json,
                     row_number() over (partition by p.id order by boxes.idx) as rn
              from parsed p join boxes
                on p.bxmax >= boxes.west and p.bxmin <= boxes.east
               and p.bymax >= boxes.south and p.bymin <= boxes.north
              where ST_Intersects(p.geom,
                ST_MakeEnvelope(boxes.west, boxes.south, boxes.east, boxes.north))
            )
            select id, height, min_height, num_floors, subtype, class, has_parts,
                   bxmin, bymin, bxmax, bymax, geom_json
            from joined where rn = 1 limit {limit}
            """
        ).fetchall()
    finally:
        con.close()

    features = []
    for (bid, height, min_height, num_floors, subtype, building_class, has_parts,
         xmin, ymin, xmax, ymax, geom_json) in rows:
        props = {
            "id": bid, "height": height, "min_height": min_height,
            "num_floors": num_floors, "subtype": subtype, "class": building_class,
            "has_parts": has_parts,
        }
        features.append({
            "type": "Feature", "id": bid, "geometry": json.loads(geom_json),
            "bbox": [xmin, ymin, xmax, ymax],
            "properties": {k: v for k, v in props.items() if v is not None},
        })
    return {"type": "FeatureCollection", "features": features, "links": [],
            "limit": limit, "bboxes": len(bboxes), "row_groups": total_rg,
            "source": "overture-index"}


def _overture_features_from_local(bboxes, limit):
    """Offline fallback: query a local bbox-clipped Overture GeoParquet
    (build_overture_buildings.py output) when the index is unreachable."""
    path = Path(OVERTURE_BUILDINGS_PARQUET)
    if not OVERTURE_BUILDINGS_PARQUET or not path.exists():
        return None
    values_sql = ",\n".join(
        f"({i}, {w:.12f}, {s:.12f}, {e:.12f}, {n:.12f})"
        for i, (w, s, e, n) in enumerate(bboxes)
    )
    parquet_path = str(path).replace("'", "''")
    import duckdb
    con = duckdb.connect(":memory:")
    try:
        load_extensions(con, spatial=True)
        rows = con.execute(
            f"""
            with boxes(idx, west, south, east, north) as (values {values_sql}),
            hits as (
              select b.id, b.height, b.min_height, b.num_floors, b.subtype,
                     b.class, b.has_parts, b.bbox_xmin, b.bbox_ymin,
                     b.bbox_xmax, b.bbox_ymax, ST_AsGeoJSON(b.geometry) as geom_json,
                     row_number() over (partition by b.id order by boxes.idx) as rn
              from read_parquet('{parquet_path}') b join boxes
                on b.bbox_xmax >= boxes.west and b.bbox_xmin <= boxes.east
               and b.bbox_ymax >= boxes.south and b.bbox_ymin <= boxes.north
              where ST_Intersects(b.geometry,
                ST_MakeEnvelope(boxes.west, boxes.south, boxes.east, boxes.north))
            )
            select * from hits where rn = 1 limit {limit}
            """
        ).fetchall()
    finally:
        con.close()
    features = []
    for (bid, height, min_height, num_floors, subtype, building_class, has_parts,
         xmin, ymin, xmax, ymax, geom_json, _rn) in rows:
        props = {
            "id": bid, "height": height, "min_height": min_height,
            "num_floors": num_floors, "subtype": subtype, "class": building_class,
            "has_parts": has_parts,
        }
        features.append({
            "type": "Feature", "id": bid, "geometry": json.loads(geom_json),
            "bbox": [xmin, ymin, xmax, ymax],
            "properties": {k: v for k, v in props.items() if v is not None},
        })
    return {"type": "FeatureCollection", "features": features, "links": [],
            "limit": limit, "bboxes": len(bboxes), "source": "overture-local"}


@app.post("/buildings/overture")
def overture_buildings(body: dict[str, Any]):
    """Return Overture building footprints intersecting one or more lon/lat bboxes.

    The viewer sends active S1M tile bboxes (OGC:CRS84). Discovery uses a small
    CONUS row-group index (build_overture_buildings_index.py): bbox-prune it to
    the viewport, then read only the matching row groups straight from Overture's
    public S3 -- no building geometry is materialized in this repo or the bucket.
    Falls back to a local bbox-clipped GeoParquet when the index is unreachable.
    """
    bboxes = _parse_viewport_bboxes(body)
    if not bboxes:
        return {"type": "FeatureCollection", "features": [], "links": []}
    try:
        limit = int(body.get("limit") or 30000)
    except (TypeError, ValueError):
        limit = 30000
    limit = max(1, min(limit, 100000))

    result = _overture_features_from_index(bboxes, limit)
    if result is None:
        result = _overture_features_from_local(bboxes, limit)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=(f"Overture buildings index not found: {OVERTURE_BUILDINGS_INDEX} "
                    "(and no local fallback configured)"),
        )
    return result


@app.post("/s1m/tiles")
def s1m_tiles(body: dict[str, Any]):
    """S1M (USGS 3DEP seamless 1 m DEM) tiles intersecting a lon/lat bbox,
    nearest-to-centre first, each with its footprint ring(s). Discovery only --
    the viewer reads each tile's elevation COG directly from the public prd-tnm
    bucket. Folded in from the former standalone S1M service (same origin as the
    viewer now, so no CORS/token needed); reads only the public S1M index."""
    bbox = body.get("bbox") or []
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox must be [west, south, east, north].")
    try:
        west, south, east, north = (float(v) for v in bbox)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="bbox values must be numbers.")
    center = body.get("center")
    order_center = tuple(center) if isinstance(center, (list, tuple)) and len(center) == 2 else None
    raw_max = body.get("max_tiles")
    max_tiles = None if raw_max is None else max(1, min(int(raw_max), 10000))
    try:
        tiles = s1m.cover_tiles(west, south, east, north, max_tiles=max_tiles, order_center=order_center)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"S1M tiles lookup failed: {exc}")
    return {"tiles": tiles}


# AWS Lambda entry point. Mangum adapts the ASGI app to the Lambda event/response
# shape (works behind a Function URL or API Gateway). It is only needed on
# Lambda; locally and in docker we run `uvicorn app:app` and never import it, so
# the dependency stays optional and a missing mangum never breaks dev.
try:
    from mangum import Mangum

    handler = Mangum(app)
except ImportError:  # mangum not installed (local/docker) -- no Lambda handler
    handler = None
