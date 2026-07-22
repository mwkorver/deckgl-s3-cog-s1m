import json
import os
from pathlib import Path
from secrets import compare_digest
from threading import Thread
from time import monotonic
from typing import Any
from uuid import uuid4

import s1m
from aws_s3 import (
    maybe_sign_s3_href,
    prepare_signed_hrefs,
    reset_aws_credentials_cache,
    rewrite_feature_assets,
    validate_signable_s3_href,
)
from config import (
    COLLECTION_ID,
    INGEST_MODE,
    INGEST_TOKEN,
    LAKE_ROOT,
    LOCAL_MODULE_DIRS,
    OVERTURE_BUILDINGS_INDEX,
    OVERTURE_BUILDINGS_PARQUET,
    OVERTURE_SOURCE_REGION,
    SEARCH_SIGN_ASSETS,
    SIGN_ASSET_URLS,
    SYNC_INGEST_DEFAULT_LIMIT,
    SYNC_INGEST_MAX_LIMIT,
    VIEWER_DIR,
)
from duckdb_s3 import load_extensions
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from ingest_jobs import get_ingest_job, run_ingest_job, set_ingest_job
from ingest_options import build_ingest_options
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
        expired = is_expired_token_error(exc)
        invalidated = "has been invalidated" in str(exc).lower() or "must be restarted" in str(exc).lower()
        if not expired and not invalidated:
            raise
        reset_lake_duckdb()
        if expired:
            reset_aws_credentials_cache()
        if retried:
            raise
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


_REGISTRY_EXTENT: dict[str, dict[str, Any]] | None = None


def _registry_extent_by_id() -> dict[str, dict[str, Any]]:
    """Title + extent (region_code, region_kind, years, bbox) per collection, read
    once from the registry-compiled collections.geojson. Enriches /collections so
    it carries real metadata instead of bare ids -- the same file the viewer reads
    for its collection panel."""
    global _REGISTRY_EXTENT
    if _REGISTRY_EXTENT is None:
        out: dict[str, dict[str, Any]] = {}
        try:
            fc = json.loads((VIEWER_DIR / "collections.geojson").read_text())
            for feat in fc.get("features", []):
                p = feat.get("properties", {})
                cid = p.get("id")
                if cid:
                    out[cid] = {k: p.get(k) for k in ("title", "region_code", "region_kind", "years", "bbox")}
        except Exception:
            out = {}
        _REGISTRY_EXTENT = out
    return _REGISTRY_EXTENT


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
        ) from exc
    reg = _registry_extent_by_id()
    return {
        "collections": [
            {
                "id": cid,
                "type": "Collection",
                "title": (reg.get(cid) or {}).get("title") or cid.upper(),
                "properties": {
                    k: v
                    for k, v in (reg.get(cid) or {}).items()
                    if k != "title" and v is not None
                },
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
        raise HTTPException(status_code=400, detail=f"invalid year: {year!r}") from None
    # Default to COG-headers: authoritative + complete, works for any collection,
    # no third-party STAC dependency. manifest-earthsearch can silently drop tiles
    # (it once ingested 430 of WA-2023's 5,720) and is kept only as opt-in.
    strategy = str(body.get("strategy") or "manifest-cog-headers")

    bucket = body.get("source_bucket")
    prefix = body.get("source_prefix")
    access = body.get("source_access")

    import descriptors
    collection_id = str(body.get("collection") or COLLECTION_ID)

    if collection_id not in descriptors._REGISTRY and not bucket:
        try:
            descriptor = descriptors.get_descriptor(collection_id)
            bucket = descriptor.bucket
            access = descriptor.access
            if hasattr(descriptor, "discovery") and hasattr(descriptor.discovery, "enumerate_prefixes"):
                prefixes = descriptor.discovery.enumerate_prefixes(None, bucket, state, year)
                if prefixes:
                    prefix = prefixes[0]
        except Exception:
            pass

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
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        try:
            descriptor = descriptors.get_descriptor(collection_id)
            collection = descriptor.id
        except SystemExit as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Optional per-partition cap; absent/0 means "all" (CLI default).
    raw_limit = body.get("limit_per_partition")
    try:
        limit_per_partition = int(raw_limit) if raw_limit not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid limit_per_partition") from None
    if limit_per_partition is not None and limit_per_partition < 0:
        raise HTTPException(status_code=400, detail="limit_per_partition must be >= 0")

    raw_workers = body.get("max_workers")
    try:
        max_workers = int(raw_workers) if raw_workers not in (None, "") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid max_workers") from None
    if max_workers is not None and (max_workers < 1 or max_workers > 128):
        raise HTTPException(status_code=400, detail="max_workers must be between 1 and 128")

    access_key_id = body.get("source_access_key_id")
    secret_access_key = body.get("source_secret_access_key")

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
            "max_workers": max_workers,
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
            "max_workers": max_workers,
            "source_access_key_id": access_key_id,
            "source_secret_access_key": secret_access_key,
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
        raise HTTPException(status_code=400, detail=f"invalid year: {year!r}") from None

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
        raise HTTPException(status_code=400, detail="invalid limit_per_partition") from None
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

    if collection_id not in descriptors._REGISTRY and not bucket:
        try:
            descriptor = descriptors.get_descriptor(collection_id)
            bucket = descriptor.bucket
            access = descriptor.access
            if hasattr(descriptor, "discovery") and hasattr(descriptor.discovery, "enumerate_prefixes"):
                prefixes = descriptor.discovery.enumerate_prefixes(None, bucket, state, year)
                if prefixes:
                    prefix = prefixes[0]
        except Exception:
            pass

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
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        try:
            descriptor = descriptors.get_descriptor(collection_id)
            collection = descriptor.id
        except SystemExit as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    raw_workers = body.get("max_workers")
    try:
        max_workers = int(raw_workers) if raw_workers not in (None, "") else 16
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid max_workers") from None
    if max_workers < 1 or max_workers > 128:
        raise HTTPException(status_code=400, detail="max_workers must be between 1 and 128")

    access_key_id = body.get("source_access_key_id")
    secret_access_key = body.get("source_secret_access_key")

    # Lazy import: keep duckdb/ingest off the cold-start path for non-ingest
    # requests (the read API is the common case).
    from types import SimpleNamespace

    import ingest_duckdb as ig

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
        max_workers=max_workers,
        source_access_key_id=access_key_id,
        source_secret_access_key=secret_access_key,
    )

    started = monotonic()
    try:
        payloads = ig.acquire_payloads(args)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ingest acquisition failed: {exc}") from exc

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
        raise HTTPException(status_code=500, detail=f"ingest export failed: {exc}") from exc

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
    # a mixed-resolution state-year shows its finest.
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
        rows = lake_query(lambda cur: cur.execute(lake_sql).fetchall())
        for state, year, year_gsd, xmin, ymin, xmax, ymax in rows:
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
        raise HTTPException(status_code=500, detail=f"availability query failed: {exc}") from exc
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
        raise HTTPException(status_code=400, detail="bbox values must be numeric") from None
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
            raise HTTPException(status_code=500, detail=f"naip coverage mvt failed: {exc}") from exc

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
        raise HTTPException(status_code=400, detail="bbox values must be numbers.") from None
    center = body.get("center")
    order_center = tuple(center) if isinstance(center, (list, tuple)) and len(center) == 2 else None
    raw_max = body.get("max_tiles")
    max_tiles = None if raw_max is None else max(1, min(int(raw_max), 10000))
    try:
        tiles = s1m.cover_tiles(west, south, east, north, max_tiles=max_tiles, order_center=order_center)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"S1M tiles lookup failed: {exc}") from exc
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
