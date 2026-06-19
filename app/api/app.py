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

import boto3
from botocore.exceptions import BotoCoreError, CredentialRetrievalError, ClientError
from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse

COLLECTION_ID = os.environ.get("S3_COG_COLLECTION_ID", "naip")
# Root of the GeoParquet lake (written by ingest_duckdb.py). Every read path
# (/search, /availability) queries this tree directly with an in-process DuckDB
# connection -- there is no database server. The api container mounts ./cache at
# /cache, so this resolves to local Parquet files (or an s3:// prefix on Lambda).
LAKE_ROOT = os.environ.get("S3_COG_LAKE_ROOT", "/cache/exports/naip_rgbir_duckdb").rstrip("/")
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
MANIFEST_INDEX = os.environ.get("S3_COG_MANIFEST_INDEX", "/cache/manifest_index").rstrip("/")
OVERTURE_BUILDINGS_PARQUET = os.environ.get(
    "S3_COG_OVERTURE_BUILDINGS_PARQUET",
    "/cache/overture/buildings_nj.parquet",
)
# The published flat NAIP manifest (requester-pays). The index is derived from
# it, so comparing its LastModified to the newest index object tells us whether
# AWS has republished the manifest (new COGs) since the index was last built.
MANIFEST_SOURCE = os.environ.get("S3_COG_MANIFEST_SOURCE", "s3://naip-analytic/manifest.txt")
# The single ingest path: reads the manifest index and writes GeoParquet to
# LAKE_ROOT (no Postgres, no staging table).
INGEST_SCRIPT_PATH = Path(__file__).parent / "ingest_duckdb.py"

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
                duckdb_s3.configure(con, LAKE_ROOT, spatial=True)

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


def _descriptor_for_source(bucket: str, key: str):
    import descriptors

    for descriptor in descriptors._REGISTRY.values():
        if descriptor.bucket == bucket and descriptor.key_filter(key):
            return descriptor
    return None


def _s3_params_for_source(bucket: str, key: str, range_header: str | None = None):
    descriptor = _descriptor_for_source(bucket, key)
    if descriptor is None:
        raise HTTPException(
            status_code=403,
            detail="S3 object is not an allowed collection source asset",
        )
    params: dict[str, Any] = {"Bucket": bucket, "Key": key}
    if range_header:
        params["Range"] = range_header
    if descriptor.request_payer:
        params["RequestPayer"] = descriptor.request_payer
    return descriptor, params


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
    source_bucket: str | None = None,
    source_prefix: str | None = None,
    source_access: str | None = None,
):
    command = [sys.executable, str(INGEST_SCRIPT_PATH),
               "--collection", collection, "--states", state, "--strategy", strategy]
    if source_bucket:
        command.extend(["--source-bucket", source_bucket, "--source-region", state])
        if source_prefix:
            command.extend(["--source-prefix", source_prefix])
        if source_access:
            command.extend(["--source-access", source_access])
        if year is not None:
            command.extend(["--source-year", str(year)])
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
    source_bucket = str(body.get("source_bucket") or "").strip()
    source_prefix = str(body.get("source_prefix") or "").strip()
    source_access = str(body.get("source_access") or "public").strip() or "public"
    if source_access not in {"public", "private", "requester-pays"}:
        raise HTTPException(status_code=400, detail=f"invalid source_access: {source_access!r}")
    state = str(body.get("source_region") or body.get("state") or "").strip().lower()
    if not state:
        raise HTTPException(status_code=400, detail="source_region is required")
    # Require a single explicit year. Ingesting "all years" fans out into one
    # EarthSearch STAC query per page across every year -- too aggressive on the
    # public endpoint -- so the panel must pick exactly one year at a time.
    year = body.get("source_year", body.get("year"))
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
    if source_bucket.startswith("s3://") and not source_prefix:
        rest = source_bucket[len("s3://"):]
        bucket_name, _, key_prefix = rest.partition("/")
        source_bucket = bucket_name
        source_prefix = key_prefix
    collection = str(body.get("collection") or (source_bucket if source_bucket else COLLECTION_ID))
    collection = "".join(ch for ch in collection.lower() if ch.isalnum() or ch in "-_") or COLLECTION_ID
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
            "source_bucket": source_bucket or None,
            "source_prefix": source_prefix or None,
            "source_access": source_access if source_bucket else None,
            "state": state,
            "year": year,
            "strategy": strategy,
            "limit_per_partition": limit_per_partition,
            "logs": [],
        },
    )
    thread = Thread(
        target=_run_ingest_job,
        args=(job_id, state, year, strategy, limit_per_partition, collection, source_bucket or None, source_prefix or None, source_access if source_bucket else None),
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

    source_bucket = str(body.get("source_bucket") or "").strip()
    source_prefix = str(body.get("source_prefix") or "").strip()
    source_access = str(body.get("source_access") or "public").strip() or "public"
    if source_access not in {"public", "private", "requester-pays"}:
        raise HTTPException(status_code=400, detail=f"invalid source_access: {source_access!r}")
    if source_bucket.startswith("s3://") and not source_prefix:
        rest = source_bucket[len("s3://"):]
        bucket_name, _, key_prefix = rest.partition("/")
        source_bucket = bucket_name
        source_prefix = key_prefix

    state = str(body.get("source_region") or body.get("state") or "").strip().lower()
    if not state:
        raise HTTPException(status_code=400, detail="source_region is required")

    # Same single-year guard as /ingest/run: one explicit year, no fan-out.
    year = body.get("source_year", body.get("year"))
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

    collection = str(body.get("collection") or (source_bucket if source_bucket else COLLECTION_ID))
    collection = "".join(ch for ch in collection.lower() if ch.isalnum() or ch in "-_") or COLLECTION_ID
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
        source_bucket=source_bucket or None,
        source_prefix=source_prefix,
        source_access=source_access,
        source_region=state,
        source_year=year,
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
            "source_bucket": source_bucket or None,
            "source_prefix": source_prefix or None,
            "strategy": strategy,
            "limit_per_partition": limit,
            "rows_ingested": 0,
            "elapsed_ms": round((monotonic() - started) * 1000, 1),
            "detail": "no assets found for this source region/year",
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
        "source_bucket": source_bucket or None,
        "source_prefix": source_prefix or None,
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
    # a mixed-resolution state-year shows its finest available imagery.
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
        raise HTTPException(status_code=500, detail=f"availability query failed: {exc}")
    return {"engine": "duckdb", "states": dict(sorted(states.items())), "gsd": gsd, "extent": extent}


@app.post("/buildings/overture")
def overture_buildings(body: dict[str, Any]):
    """Return Overture building footprints intersecting one or more lon/lat bboxes.

    The viewer sends active S1M tile bboxes, already transformed to OGC:CRS84.
    The local Overture file carries explicit bbox columns, so DuckDB can filter
    cheaply before the exact geometry intersection.
    """
    path = Path(OVERTURE_BUILDINGS_PARQUET)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Overture buildings parquet not found: {path}")

    raw_bboxes = body.get("bboxes") or []
    bboxes: list[tuple[int, float, float, float, float]] = []
    for idx, bbox in enumerate(raw_bboxes[:32]):
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            west, south, east, north = [float(v) for v in bbox]
        except (TypeError, ValueError):
            continue
        if west >= east or south >= north:
            continue
        bboxes.append((idx, west, south, east, north))
    if not bboxes:
        return {"type": "FeatureCollection", "features": [], "links": []}

    try:
        limit = int(body.get("limit") or 30000)
    except (TypeError, ValueError):
        limit = 30000
    limit = max(1, min(limit, 100000))

    values_sql = ",\n".join(
        f"({idx}, {west:.12f}, {south:.12f}, {east:.12f}, {north:.12f})"
        for idx, west, south, east, north in bboxes
    )
    parquet_path = str(path).replace("'", "''")
    import duckdb

    con = duckdb.connect(":memory:")
    try:
        con.execute("LOAD spatial")
        rows = con.execute(
            f"""
            with boxes(idx, west, south, east, north) as (
              values {values_sql}
            ),
            hits as (
              select
                b.id,
                b.height,
                b.min_height,
                b.num_floors,
                b.subtype,
                b.class,
                b.has_parts,
                b.bbox_xmin,
                b.bbox_ymin,
                b.bbox_xmax,
                b.bbox_ymax,
                ST_AsGeoJSON(b.geometry) as geom_json,
                row_number() over (partition by b.id order by boxes.idx) as rn
              from read_parquet('{parquet_path}') b
              join boxes
                on b.bbox_xmax >= boxes.west
               and b.bbox_xmin <= boxes.east
               and b.bbox_ymax >= boxes.south
               and b.bbox_ymin <= boxes.north
              where ST_Intersects(
                b.geometry,
                ST_MakeEnvelope(boxes.west, boxes.south, boxes.east, boxes.north)
              )
            )
            select *
            from hits
            where rn = 1
            limit {limit}
            """
        ).fetchall()
    finally:
        con.close()

    features = []
    for row in rows:
        (
            bid,
            height,
            min_height,
            num_floors,
            subtype,
            building_class,
            has_parts,
            xmin,
            ymin,
            xmax,
            ymax,
            geom_json,
            _rn,
        ) = row
        props = {
            "id": bid,
            "height": height,
            "min_height": min_height,
            "num_floors": num_floors,
            "subtype": subtype,
            "class": building_class,
            "has_parts": has_parts,
        }
        features.append({
            "type": "Feature",
            "id": bid,
            "geometry": json.loads(geom_json),
            "bbox": [xmin, ymin, xmax, ymax],
            "properties": {k: v for k, v in props.items() if v is not None},
        })
    return {
        "type": "FeatureCollection",
        "features": features,
        "links": [],
        "limit": limit,
        "bboxes": len(bboxes),
    }


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


def _tile_proxy_headers(obj: dict[str, Any], *, partial: bool) -> dict[str, str]:
    headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
    }
    content_type = obj.get("ContentType")
    if content_type:
        headers["Content-Type"] = content_type
    for source, target in (
        ("ContentLength", "Content-Length"),
        ("ContentRange", "Content-Range"),
        ("ETag", "ETag"),
        ("LastModified", "Last-Modified"),
    ):
        value = obj.get(source)
        if value is not None:
            headers[target] = value.isoformat() if hasattr(value, "isoformat") else str(value)
    if partial and obj.get("ContentLength") is not None:
        headers["Content-Length"] = str(obj["ContentLength"])
    return headers


@app.head("/tiles/{bucket}/{key:path}")
def tile_proxy_head(bucket: str, key: str):
    _, params = _s3_params_for_source(bucket, key)
    params.pop("Range", None)
    try:
        obj = get_s3_direct_client().head_object(**params)
    except ClientError as exc:
        code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 502)
        raise HTTPException(status_code=code if 400 <= code < 600 else 502, detail=str(exc)) from exc
    return Response(status_code=200, headers=_tile_proxy_headers(obj, partial=False))


@app.get("/tiles/{bucket}/{key:path}")
def tile_proxy_get(bucket: str, key: str, range: str | None = Header(default=None)):
    """Restricted local COG proxy for registered source assets only."""
    _, params = _s3_params_for_source(bucket, key, range)
    try:
        obj = get_s3_direct_client().get_object(**params)
    except ClientError as exc:
        code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 502)
        raise HTTPException(status_code=code if 400 <= code < 600 else 502, detail=str(exc)) from exc
    status_code = 206 if obj.get("ContentRange") else 200
    return StreamingResponse(
        obj["Body"].iter_chunks(),
        status_code=status_code,
        headers=_tile_proxy_headers(obj, partial=status_code == 206),
        media_type=obj.get("ContentType") or "application/octet-stream",
    )


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


# AWS Lambda entry point. Mangum adapts the ASGI app to the Lambda event/response
# shape (works behind a Function URL or API Gateway). It is only needed on
# Lambda; locally and in docker we run `uvicorn app:app` and never import it, so
# the dependency stays optional and a missing mangum never breaks dev.
try:
    from mangum import Mangum

    handler = Mangum(app)
except ImportError:  # mangum not installed (local/docker) -- no Lambda handler
    handler = None
