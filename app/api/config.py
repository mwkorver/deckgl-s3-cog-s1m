import os
from pathlib import Path


# Clean up empty AWS environment variables to prevent boto3 ProfileNotFound errors.
for var in ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]:
    if var in os.environ and not os.environ[var].strip():
        del os.environ[var]


COLLECTION_ID = os.environ.get("S3_COG_COLLECTION_ID", "naip")
# Root of the GeoParquet lake (written by ingest_duckdb.py). Every read path
# (/search, /availability) queries this tree directly with an in-process DuckDB
# connection -- there is no database server. The api container mounts ./cache at
# /cache, so this resolves to local Parquet files (or an s3:// prefix on Lambda).
LAKE_ROOT = os.environ.get("S3_COG_LAKE_ROOT", "/cache/exports/naip_rgbir_duckdb")
# CONUS row-group index over the public Overture buildings release (built by
# build_overture_buildings_index.py, seeded into the lake at
# lake/overture-buildings/index.parquet). /buildings/overture bbox-prunes this
# index to a viewport, then reads the matching row groups straight from Overture's
# public S3 -- the same thin-index/stream-on-demand strategy as the NAIP/S1M
# lakes, so no building geometry is materialized into this repo or the bucket.
OVERTURE_BUILDINGS_INDEX = os.environ.get(
    "S3_COG_OVERTURE_BUILDINGS_INDEX",
    "/cache/overture/buildings-index.parquet",
)
# AWS region of the public Overture bucket the index points into. Reads are
# anonymous (the dataset is public, no requester-pays, no signing).
OVERTURE_SOURCE_REGION = os.environ.get("S3_COG_OVERTURE_SOURCE_REGION", "us-west-2")
# Optional offline fallback: a local bbox-clipped Overture GeoParquet (built by
# build_overture_buildings.py). Used only when the index above is unreachable,
# so fully-offline runs still draw buildings. Empty/unset disables the fallback.
OVERTURE_BUILDINGS_PARQUET = os.environ.get("S3_COG_OVERTURE_BUILDINGS_PARQUET", "")
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
# Base URL of the dedicated container-image ingest function (deckgl-s3-cog-ingest).
# The read-only zip Lambda has INGEST_MODE=disabled but sets this so the viewer
# can POST ingest cross-origin to the container function instead. Empty locally
# (ingest runs in-process) and on the ingest function itself.
INGEST_URL = (os.environ.get("S3_COG_INGEST_URL") or "").rstrip("/")
# Shared token required by public write ingest endpoints. Local dev may leave
# this unset; Lambda write endpoints fail closed when it is missing.
INGEST_TOKEN = os.environ.get("S3_COG_INGEST_TOKEN", "")
MODULE_DIR = Path(__file__).resolve().parent
VIEWER_DIR = MODULE_DIR / "viewer"
if not VIEWER_DIR.exists():
    VIEWER_DIR = MODULE_DIR.parent / "viewer"
DEFAULT_REPO_ROOT = (
    Path(__file__).resolve().parents[2] if len(Path(__file__).resolve().parents) > 2 else Path(__file__).resolve().parent
)
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

# Default + ceiling on COGs per (region, year) partition for the synchronous
# path. DEFAULT keeps an empty/absent request light; MAX is the largest finite
# value the panel/sync path accepts (0 = unlimited bypasses it). The sync path is
# still bounded by the invocation timeout (~30s via API Gateway, ~900s via the
# ingest Lambda at ~50 COG-header reads/s), so big partitions should use the
# async/background job; this ceiling just stops the panel from silently clamping.
SYNC_INGEST_DEFAULT_LIMIT = int(os.environ.get("S3_COG_SYNC_INGEST_DEFAULT_LIMIT", "50"))
SYNC_INGEST_MAX_LIMIT = int(os.environ.get("S3_COG_SYNC_INGEST_MAX_LIMIT", "20000"))


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
    "wy": [-111.056888, 40.994746, -104.05216, 45.005904],
}
