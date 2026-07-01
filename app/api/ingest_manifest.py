import argparse
import json
import os
import re
import io
import threading

_pyproj_lock = threading.RLock()

# Clean up empty AWS environment variables to prevent boto3 ProfileNotFound errors
for var in ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]:
    if var in os.environ and not os.environ[var].strip():
        del os.environ[var]

from collections import defaultdict
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from PIL import Image

# We only read GeoTIFF header tags here, never decode pixels, so PIL's
# decompression-bomb guard (which warns/raises on large dimensions) is just
# noise for full-size NAIP COGs. Disable it for this header-only path.
Image.MAX_IMAGE_PIXELS = None
from pyproj import Transformer

EARTHSEARCH_API = os.environ.get("S3_COG_EARTHSEARCH_API", "https://earth-search.aws.element84.com/v1/search")
EARTHSEARCH_PAGE_SIZE = int(os.environ.get("S3_COG_EARTHSEARCH_PAGE_SIZE", "500"))
# Local cache lives at app/cache, one level up from this api/ dir.
# Derive from __file__ so defaults work wherever the repo is cloned (no
# hardcoded home path); override via the env vars or CLI args.
_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
MANIFEST_PATH = Path(
    os.environ.get(
        "S3_COG_MANIFEST_PATH",
        str(_CACHE_DIR / "naip-analytic-manifest.txt"),
    )
)
# Partitioned Parquet index produced by build_manifest_index.py. Reading the
# index (pushdown by state/naip_year) replaces the full 404MB text scan that
# build_manifest_inventory does. RGBIR COGs only; no FGDC sidecars, so the
# index-backed path carries no metadata_href (the lake ingest does not use it).
MANIFEST_INDEX_PATH = os.environ.get(
    "S3_COG_MANIFEST_INDEX",
    str(_CACHE_DIR / "manifest_index"),
).rstrip("/")

FILENAME_RE = re.compile(
    r"^(?:m_)?(\d{7})_(ne|nw|se|sw)_(\d{1,2})_([a-z0-9]+)(?:_(\d{8})(?:_(\d{8}))?)?\.tif$",
    re.IGNORECASE,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Ingest NAIP assets using manifest inventory plus EarthSearch STAC enrichment"
    )
    parser.add_argument("--states", nargs="+", default=["ri", "ct", "de", "nj"])
    parser.add_argument("--years", nargs="+", type=int, help="Optional explicit NAIP years")
    parser.add_argument(
        "--latest-year-only",
        action="store_true",
        help="For each requested state, ingest only the most recent year found in the manifest",
    )
    parser.add_argument(
        "--limit-per-partition",
        type=int,
        default=0,
        help="Optional cap per state/year/resolution partition; 0 means all",
    )
    parser.add_argument("--page-size", type=int, default=EARTHSEARCH_PAGE_SIZE)
    parser.add_argument(
        "--strategy",
        choices=["manifest-earthsearch", "manifest-cog-headers"],
        default="manifest-earthsearch",
        help="Ingest and metadata enrichment strategy",
    )
    return parser.parse_args()


def parse_date(value: str | None):
    if not value:
        return None
    return date(int(value[0:4]), int(value[4:6]), int(value[6:8]))


def parse_datetime_date(value: str | None):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).date()


def parse_filename(filename: str):
    match = FILENAME_RE.match(filename)
    if not match:
        return None
    apfo_name, quadrant, zone, resolution_token, acquisition_date, verification_date = match.groups()
    return {
        "apfo_name": apfo_name,
        "quadrant": quadrant.upper(),
        "zone": zone,
        "resolution_token": resolution_token,
        "acquisition_date": parse_date(acquisition_date),
        "verification_date": parse_date(verification_date),
    }


def post_json(url: str, body: dict[str, Any]):
    started_at = perf_counter()
    request = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request) as response:
            payload = json.loads(response.read().decode("utf-8"))
            elapsed_ms = (perf_counter() - started_at) * 1000
            return payload, elapsed_ms
    except HTTPError as exc:
        raise RuntimeError(f"EarthSearch request failed with HTTP {exc.code}: {exc.reason}") from exc
    except URLError as exc:
        raise RuntimeError(f"EarthSearch request failed: {exc}") from exc


def partition_from_key(key: str):
    parts = key.split("/")
    if len(parts) < 5:
        return None
    state, year, resolution_dir, product_family, spatial_prefix = parts[:5]
    if len(state) != 2 or not year.isdigit():
        return None
    return {
        "state": state,
        "naip_year": int(year),
        "resolution_dir": resolution_dir,
        "product_family": product_family,
        "spatial_prefix": spatial_prefix,
        "filename": parts[-1],
        "source_key": key,
    }


def determine_latest_years(states: set[str]):
    latest_by_state: dict[str, int] = {}
    with MANIFEST_PATH.open() as handle:
        for line in handle:
            key = line.strip()
            parsed = partition_from_key(key)
            if not parsed:
                continue
            state = parsed["state"]
            if state not in states:
                continue
            latest_by_state[state] = max(parsed["naip_year"], latest_by_state.get(state, 0))
    return latest_by_state


def build_manifest_inventory(states: set[str], years: set[int] | None, latest_year_only: bool, limit_per_partition: int):
    if not MANIFEST_PATH.exists():
        raise RuntimeError(f"manifest file not found: {MANIFEST_PATH}")

    latest_by_state = determine_latest_years(states) if latest_year_only else {}
    selected: dict[str, dict[str, Any]] = {}
    partition_counts: dict[tuple[str, int, str], int] = defaultdict(int)
    metadata_by_base: dict[tuple[str, int, str, str], str] = {}

    with MANIFEST_PATH.open() as handle:
        for line in handle:
            key = line.strip()
            parsed = partition_from_key(key)
            if not parsed:
                continue
            state = parsed["state"]
            year = parsed["naip_year"]
            if state not in states:
                continue
            if latest_year_only and latest_by_state.get(state) != year:
                continue
            if years and year not in years:
                continue

            product_family = parsed["product_family"]
            partition_key = (state, year, parsed["resolution_dir"])
            if product_family == "rgbir_cog" and key.lower().endswith(".tif"):
                if limit_per_partition and partition_counts[partition_key] >= limit_per_partition:
                    continue
                asset_href = f"s3://naip-analytic/{key}"
                selected[asset_href] = {
                    "source_bucket": "naip-analytic",
                    **parsed,
                    "asset_href": asset_href,
                }
                partition_counts[partition_key] += 1
            elif product_family == "fgdc":
                suffix = Path(key).suffix.lower()
                if suffix not in {".xml", ".txt"}:
                    continue
                metadata_by_base[(state, year, parsed["resolution_dir"], Path(parsed["filename"]).stem)] = key

    for row in selected.values():
        base = Path(row["filename"]).stem
        metadata_key = metadata_by_base.get((row["state"], row["naip_year"], row["resolution_dir"], base))
        row["metadata_href"] = f"s3://naip-analytic/{metadata_key}" if metadata_key else None

    print(
        f"manifest selected {len(selected):,} assets for states={sorted(states)} years={sorted(years) if years else 'latest' if latest_year_only else 'all'}",
        flush=True,
    )
    return selected, latest_by_state


def build_manifest_inventory_from_index(
    states: set[str],
    years: set[int] | None,
    latest_year_only: bool,
    limit_per_partition: int,
    index_root: str = MANIFEST_INDEX_PATH,
):
    """Index-backed equivalent of build_manifest_inventory.

    Reads the partitioned Parquet manifest index (build_manifest_index.py)
    instead of streaming the 404MB text manifest, using DuckDB to push the
    state/naip_year filters into partition pruning. Returns the SAME
    (selected, latest_by_state) shape the text-scan version returns, so
    acquire_payloads can use either interchangeably -- minus metadata_href,
    which the index does not carry (RGBIR COGs only; lake ingest does not use
    it). This path is for the PostGIS-free lake ingest (ingest_duckdb.py).
    """
    import duckdb

    import duckdb_s3

    # Local paths must exist up front; s3:// paths are validated lazily by
    # httpfs when the read runs (no client-side stat).
    if not str(index_root).startswith("s3://") and not Path(index_root).exists():
        raise RuntimeError(
            f"manifest index not found: {index_root} (run build_manifest_index.py)"
        )

    con = duckdb.connect()
    duckdb_s3.configure(con, index_root, spatial=False)
    glob = f"{index_root}/**/*.parquet"
    rel = con.sql(
        f"select source_key, state, naip_year, resolution, quad, filename "
        f"from read_parquet('{glob}', hive_partitioning=true)"
    )
    con.register("idx", rel)

    state_list = ", ".join(f"'{s}'" for s in sorted(states))
    where = [f"state in ({state_list})"] if states else []

    # latest_by_state: one max(naip_year) per state, computed in SQL.
    latest_rows = con.sql(
        f"select state, max(naip_year) as y from idx where state in ({state_list}) group by state"
    ).fetchall() if states else []
    latest_by_state = {state: int(year) for state, year in latest_rows}

    if latest_year_only:
        # keep only each state's latest year
        pairs = " or ".join(
            f"(state = '{s}' and naip_year = {y})" for s, y in latest_by_state.items()
        )
        where.append(f"({pairs})" if pairs else "false")
    elif years:
        year_list = ", ".join(str(int(y)) for y in years)
        where.append(f"naip_year in ({year_list})")

    where_sql = " and ".join(where) if where else "true"

    if limit_per_partition and limit_per_partition > 0:
        # cap rows per (state, naip_year, resolution) partition, mirroring the
        # text path's partition_counts gate.
        query = f"""
          select source_key, state, naip_year, resolution, quad, filename
          from (
            select *, row_number() over (
              partition by state, naip_year, resolution order by source_key
            ) as rn
            from idx
            where {where_sql}
          )
          where rn <= {int(limit_per_partition)}
        """
    else:
        query = f"""
          select source_key, state, naip_year, resolution, quad, filename
          from idx where {where_sql}
        """

    selected: dict[str, dict[str, Any]] = {}
    for source_key, state, naip_year, resolution, quad, filename in con.sql(query).fetchall():
        asset_href = f"s3://naip-analytic/{source_key}"
        selected[asset_href] = {
            "source_bucket": "naip-analytic",
            "source_key": source_key,
            "asset_href": asset_href,
            "metadata_href": None,  # index carries no FGDC sidecar (option 1)
            "state": state,
            "naip_year": int(naip_year),
            "resolution_dir": resolution,
            "product_family": "rgbir_cog",
            "spatial_prefix": quad,
            "filename": filename,
        }
    con.close()

    print(
        f"manifest index selected {len(selected):,} assets for states={sorted(states)} "
        f"years={sorted(years) if years else 'latest' if latest_year_only else 'all'}",
        flush=True,
    )
    return selected, latest_by_state


def earthsearch_items_for_state(state: str, page_size: int, year: int | None = None):
    query: dict[str, Any] = {"naip:state": {"eq": state}}
    if year is not None:
        query["naip:year"] = {"eq": str(year)}
    body: dict[str, Any] = {"collections": ["naip"], "limit": page_size, "query": query}
    page = 0
    while True:
        page += 1
        data, request_ms = post_json(EARTHSEARCH_API, body)
        features = data.get("features") or []
        print(
            f"earthsearch state={state} year={year or 'all'} page={page} returned={len(features)} matched={data.get('numberMatched') or data.get('context', {}).get('matched')} request_ms={request_ms:.1f}",
            flush=True,
        )
        for feature in features:
            yield feature
        next_link = next((link for link in data.get("links", []) if link.get("rel") == "next"), None)
        if not next_link:
            return
        body = next_link.get("body")
        if not isinstance(body, dict):
            raise RuntimeError("EarthSearch next link missing POST body")


def build_stac_index(states: set[str], years_by_state: dict[str, int | None], page_size: int):
    index: dict[str, dict[str, Any]] = {}
    for state in sorted(states):
        year = years_by_state.get(state)
        for feature in earthsearch_items_for_state(state, page_size, year=year):
            image_asset = ((feature.get("assets") or {}).get("image") or {})
            href = image_asset.get("href")
            if isinstance(href, str):
                index[href] = feature
    print(f"earthsearch indexed {len(index):,} items", flush=True)
    return index


@lru_cache(maxsize=64)
def transformer_to_wgs84(crs):
    # crs may be an EPSG int or a CRS name string (e.g. a GeoTIFF citation for a
    # user-defined CRS). pyproj.Transformer.from_crs resolves both.
    with _pyproj_lock:
        return Transformer.from_crs(crs, 4326, always_xy=True)


def geometry_from_proj_bbox(proj_bbox: list[float], crs):
    minx, miny, maxx, maxy = [float(value) for value in proj_bbox]
    with _pyproj_lock:
        transformer = transformer_to_wgs84(crs)
        corners = [
            transformer.transform(minx, miny),
            transformer.transform(maxx, miny),
            transformer.transform(maxx, maxy),
            transformer.transform(minx, maxy),
        ]
    return {
        "type": "Polygon",
        "coordinates": [[
            [corners[0][0], corners[0][1]],
            [corners[1][0], corners[1][1]],
            [corners[2][0], corners[2][1]],
            [corners[3][0], corners[3][1]],
            [corners[0][0], corners[0][1]],
        ]],
    }


def row_to_insertable(manifest_row: dict[str, Any], item: dict[str, Any]):
    filename_parts = parse_filename(manifest_row["filename"])
    if not filename_parts:
        raise ValueError(f"could not parse filename: {manifest_row['filename']}")

    properties = item.get("properties") or {}
    proj_epsg = properties.get("proj:epsg")
    proj_bbox = properties.get("proj:bbox")
    if proj_epsg is None or not isinstance(proj_bbox, list) or len(proj_bbox) != 4:
        raise ValueError(f"item missing proj:bbox or proj:epsg: {item.get('id')}")

    assets = item.get("assets") or {}
    image_asset = assets.get("image") or {}
    eo_bands = image_asset.get("eo:bands")
    raster_bands = image_asset.get("raster:bands")
    acquisition_date = filename_parts["acquisition_date"] or parse_datetime_date(properties.get("datetime"))
    band_count = len(raster_bands) if isinstance(raster_bands, list) else (len(eo_bands) if isinstance(eo_bands, list) else None)
    bands = None
    if isinstance(eo_bands, list):
        names = [band.get("common_name") or band.get("name") for band in eo_bands if isinstance(band, dict)]
        bands = ",".join([name for name in names if name]) or None

    geom_geojson = geometry_from_proj_bbox(proj_bbox, int(proj_epsg))

    return {
        "source_bucket": manifest_row["source_bucket"],
        "source_key": manifest_row["source_key"],
        "asset_href": manifest_row["asset_href"],
        "metadata_href": manifest_row.get("metadata_href"),
        "state": manifest_row["state"],
        "naip_year": int(properties.get("naip:year") or manifest_row["naip_year"]),
        "resolution_dir": manifest_row["resolution_dir"],
        "product_family": manifest_row["product_family"],
        "spatial_prefix": manifest_row["spatial_prefix"],
        "filename": manifest_row["filename"],
        "apfo_name": filename_parts["apfo_name"],
        "quadrant": filename_parts["quadrant"],
        "zone": filename_parts["zone"],
        "resolution_token": filename_parts["resolution_token"],
        "acquisition_date": acquisition_date,
        "verification_date": filename_parts["verification_date"],
        "proj_epsg": int(proj_epsg),
        "gsd": properties.get("gsd"),
        "band_count": band_count,
        "bands": bands,
        "proj_shape": [int(value) for value in properties.get("proj:shape", [])]
        if isinstance(properties.get("proj:shape"), list)
        else None,
        "proj_transform": [float(value) for value in properties.get("proj:transform", [])]
        if isinstance(properties.get("proj:transform"), list)
        else None,
        "geom_geojson": json.dumps(geom_geojson),
        "title": image_asset.get("title") if isinstance(image_asset, dict) else None,
        "description": None,
        "purpose": None,
        "keywords": None,
        "provider": "earth-search",
        "raw_path": json.dumps(manifest_row),
        "raw_filename_parts": json.dumps(
            {
                "apfo_name": filename_parts["apfo_name"],
                "quadrant": filename_parts["quadrant"],
                "zone": filename_parts["zone"],
                "resolution_token": filename_parts["resolution_token"],
                "acquisition_date": acquisition_date.isoformat() if acquisition_date else None,
                "verification_date": filename_parts["verification_date"].isoformat()
                if filename_parts["verification_date"]
                else None,
            }
        ),
        "raw_metadata": json.dumps(item),
        "raw_raster": json.dumps(
            {
                "proj:epsg": properties.get("proj:epsg"),
                "proj:bbox": properties.get("proj:bbox"),
                "proj:shape": properties.get("proj:shape"),
                "proj:transform": properties.get("proj:transform"),
                "gsd": properties.get("gsd"),
                "raster:bands": raster_bands,
                "eo:bands": eo_bands,
            }
        ),
    }



class S3File(io.RawIOBase):
    # GeoTIFF header (IFD + the tags we read) lives at the front of the file.
    # Prefetch this many bytes in ONE ranged GET so PIL's many small tag reads
    # are served from memory instead of one HTTP round-trip each.
    PREFETCH = 1 << 17  # 128 KiB

    def __init__(self, s3_client, bucket, key, request_payer="requester"):
        self.s3 = s3_client
        self.bucket = bucket
        self.key = key
        self.request_payer = request_payer
        self.position = 0

        # A single ranged GET returns both the header bytes AND the total size
        # (via the Content-Range header), replacing a HEAD + dozens of tiny
        # per-seek GETs. This is the difference between ~minutes and ~seconds for
        # a state-year of headers.
        params = {"Bucket": bucket, "Key": key, "Range": f"bytes=0-{self.PREFETCH - 1}"}
        if request_payer:
            params["RequestPayer"] = request_payer
        res = self.s3.get_object(**params)
        self._buf = res["Body"].read()
        content_range = res.get("ContentRange")  # e.g. "bytes 0-131071/12345678"
        self.size = int(content_range.split("/")[-1]) if content_range else len(self._buf)

    def readable(self):
        return True

    def seekable(self):
        return True

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            self.position = offset
        elif whence == io.SEEK_CUR:
            self.position += offset
        elif whence == io.SEEK_END:
            self.position = self.size + offset
        return self.position

    def tell(self):
        return self.position

    def readinto(self, b):
        length = len(b)
        if self.position >= self.size:
            return 0
        end = min(self.position + length, self.size)  # exclusive
        # Serve from the prefetched header buffer when the whole read fits inside
        # it (the common case for tag parsing); else fall back to a ranged GET.
        if end <= len(self._buf):
            data = self._buf[self.position:end]
        else:
            params = {
                "Bucket": self.bucket,
                "Key": self.key,
                "Range": f"bytes={self.position}-{end - 1}",
            }
            if self.request_payer:
                params["RequestPayer"] = self.request_payer
            try:
                data = self.s3.get_object(**params)["Body"].read()
            except Exception as e:  # noqa: BLE001
                raise OSError(f"S3 read error: {e}")
        n = len(data)
        b[:n] = data
        self.position += n
        return n


def parse_geokeys(geokey_directory):
    if not geokey_directory:
        return {}
    if len(geokey_directory) < 4:
        return {}
    num_keys = geokey_directory[3]
    keys = {}
    for i in range(num_keys):
        offset = 4 + i * 4
        if offset + 4 > len(geokey_directory):
            break
        key_id, tag_location, count, value_offset = geokey_directory[offset:offset+4]
        if tag_location == 0:
            keys[key_id] = value_offset
    return keys


def _extract_cog_geo(s3_client, bucket, key, request_payer="requester"):
    """Collection-NEUTRAL COG header read: geometry/CRS/transform/bbox/bands from
    the GeoTIFF tags. Shared by the NAIP reader (fetch_cog_metadata) and the
    generic public-prefix reader (fetch_cog_geo_generic) -- it knows nothing about
    NAIP filenames or any collection's key layout."""
    s3_file = S3File(s3_client, bucket, key, request_payer=request_payer)
    with Image.open(s3_file) as im:
        width, height = im.size
        proj_shape = [height, width]  # standard is [height, width] in proj:shape

        band_count = len(im.getbands())
        bands = "red,green,blue,nir" if band_count == 4 else ",".join(im.getbands())

        pixel_scale = im.tag_v2.get(33550)   # ModelPixelScaleTag
        tiepoints = im.tag_v2.get(33922)     # ModelTiepointTag
        geokeys_raw = im.tag_v2.get(34735)   # GeoKeyDirectoryTag
        ascii_params = im.tag_v2.get(34737)  # GeoAsciiParamsTag (CRS citation)
        if not pixel_scale or not tiepoints or not geokeys_raw:
            raise ValueError(f"Missing required GeoTIFF tags (pixel_scale, tiepoints, or geokeys) in S3 object: s3://{bucket}/{key}")

        geokeys = parse_geokeys(geokeys_raw)
        pcs = geokeys.get(3072) or geokeys.get(2048)
        if not pcs:
            raise ValueError(f"Could not determine CRS from GeoKeys in S3 object: s3://{bucket}/{key}")
        # 32767 = GeoTIFF "user-defined" sentinel: the CRS isn't a registered EPSG
        # code, it's spelled out in the GeoAsciiParams citation (e.g. NJ:
        # "NAD83(2011) / New Jersey (ftUS)"). Resolve that name via pyproj.
        if int(pcs) not in (0, 32767):
            crs, proj_epsg = int(pcs), int(pcs)
        else:
            citation = str(ascii_params).split("|")[0].strip() if ascii_params else ""
            if not citation:
                raise ValueError(f"user-defined CRS (32767) with no citation: s3://{bucket}/{key}")
            with _pyproj_lock:
                from pyproj import CRS
                crs_obj = CRS.from_user_input(citation)
                proj_epsg = crs_obj.to_epsg() or 0       # resolved EPSG when known
                crs = proj_epsg or citation              # transformer accepts int or name

        scale_x, scale_y = float(pixel_scale[0]), float(pixel_scale[1])
        tie_x, tie_y = float(tiepoints[3]), float(tiepoints[4])
        gsd = scale_x  # primary resolution, in the CRS's linear units
        proj_transform = [scale_x, 0.0, tie_x, 0.0, -scale_y, tie_y]
        minx, maxx = tie_x, tie_x + width * scale_x
        maxy, miny = tie_y, tie_y - height * scale_y
        proj_bbox = [minx, miny, maxx, maxy]
        geom = geometry_from_proj_bbox(proj_bbox, crs)

    return {
        "proj_shape": proj_shape, "band_count": band_count, "bands": bands,
        "proj_epsg": int(proj_epsg), "gsd": gsd, "proj_transform": proj_transform,
        "proj_bbox": proj_bbox, "geom": geom,
    }


def fetch_cog_metadata(s3_client, manifest_row, request_payer="requester"):
    bucket = manifest_row["source_bucket"]
    key = manifest_row["source_key"]
    filename_parts = parse_filename(manifest_row["filename"])
    if not filename_parts:
        raise ValueError(f"could not parse filename: {manifest_row['filename']}")

    geo = _extract_cog_geo(s3_client, bucket, key, request_payer=request_payer)
    proj_shape = geo["proj_shape"]
    band_count = geo["band_count"]
    bands = geo["bands"]
    proj_epsg = geo["proj_epsg"]
    gsd = geo["gsd"]
    proj_transform = geo["proj_transform"]
    proj_bbox = geo["proj_bbox"]
    geom_geojson = geo["geom"]

    acquisition_date = filename_parts["acquisition_date"]
    
    # Generate mock STAC item response compatible with the schema
    item_mock_stac = {
        "id": f"{bucket}/{key}",
        "properties": {
            "datetime": acquisition_date.isoformat() + "T00:00:00Z" if acquisition_date else None,
            "gsd": gsd,
            "naip:state": manifest_row["state"],
            "naip:year": manifest_row["naip_year"],
            "proj:epsg": int(proj_epsg),
            "proj:shape": proj_shape,
            "proj:transform": proj_transform,
        },
        "assets": {
            "image": {
                "href": manifest_row["asset_href"],
                "title": f"NAIP Imagery DOQQ {manifest_row['filename']}",
            }
        }
    }

    return {
        "source_bucket": bucket,
        "source_key": key,
        "asset_href": manifest_row["asset_href"],
        "metadata_href": manifest_row.get("metadata_href"),
        "state": manifest_row["state"],
        "naip_year": manifest_row["naip_year"],
        "resolution_dir": manifest_row["resolution_dir"],
        "product_family": manifest_row["product_family"],
        "spatial_prefix": manifest_row["spatial_prefix"],
        "filename": manifest_row["filename"],
        "apfo_name": filename_parts["apfo_name"],
        "quadrant": filename_parts["quadrant"],
        "zone": filename_parts["zone"],
        "resolution_token": filename_parts["resolution_token"],
        "acquisition_date": acquisition_date,
        "verification_date": filename_parts["verification_date"],
        "proj_epsg": int(proj_epsg),
        "gsd": gsd,
        "band_count": band_count,
        "bands": bands,
        "proj_shape": proj_shape,
        "proj_transform": proj_transform,
        "geom_geojson": json.dumps(geom_geojson),
        "title": f"NAIP Imagery DOQQ {manifest_row['filename']}",
        "description": "Raster metadata direct-ingested from COG headers",
        "purpose": "COG direct ingest",
        "keywords": None,
        "provider": "cog-direct-ingest",
        "raw_path": json.dumps(manifest_row),
        "raw_filename_parts": json.dumps(
            {
                "apfo_name": filename_parts["apfo_name"],
                "quadrant": filename_parts["quadrant"],
                "zone": filename_parts["zone"],
                "resolution_token": filename_parts["resolution_token"],
                "acquisition_date": acquisition_date.isoformat() if acquisition_date else None,
                "verification_date": filename_parts["verification_date"].isoformat()
                if filename_parts["verification_date"]
                else None,
            }
        ),
        "raw_metadata": json.dumps(item_mock_stac),
        "raw_raster": json.dumps(
            {
                "proj:epsg": int(proj_epsg),
                "proj:bbox": proj_bbox,
                "proj:shape": proj_shape,
                "proj:transform": proj_transform,
                "gsd": gsd,
            }
        ),
    }


def process_manifest_cog_headers(
    manifest_rows,
    max_workers=8,
    request_payer="requester",
    aws_access_key_id=None,
    aws_secret_access_key=None,
):
    results = []
    failed = []

    from botocore.config import Config
    config = Config(max_pool_connections=max_workers)
    if aws_access_key_id and aws_secret_access_key:
        session = boto3.Session(
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            aws_session_token=None,
        )
        s3_client = session.client("s3", config=config)
    else:
        s3_client = boto3.client("s3", config=config)

    total = len(manifest_rows)
    print(f"Began COG header parsing for {total:,} selected assets...", flush=True)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(fetch_cog_metadata, s3_client, row, request_payer): row
            for row in manifest_rows.values()
        }
        
        for idx, future in enumerate(as_completed(futures), start=1):
            row = futures[future]
            try:
                payload = future.result()
                results.append(payload)
                if idx % 10 == 0 or idx == total:
                    print(f"Parsed COG headers: {idx}/{total} assets", flush=True)
            except Exception as e:
                failed.append((row["asset_href"], str(e)))
                print(f"Failed to parse COG header for {row['asset_href']}: {e}", flush=True)

    return results, failed


def fetch_cog_geo_generic(s3_client, row, request_payer=None):
    """COG-header read for a GENERIC (S3PrefixListing) collection. region/year/
    properties already came from the descriptor's key_parser (in `row`); geometry
    comes from the header. No NAIP filename parse. Emits the canonical payload
    shape ingest_duckdb.payloads_to_arrow consumes (region/year/properties)."""
    bucket = row["source_bucket"]
    key = row["source_key"]
    geo = _extract_cog_geo(s3_client, bucket, key, request_payer=request_payer)
    return {
        "source_bucket": bucket,
        "source_key": key,
        "asset_href": row["asset_href"],
        "region": row["region"],
        "year": int(row["year"]),
        "properties": row.get("properties") or {},
        "geom_geojson": json.dumps(geo["geom"]),
        "acquisition_date": None,   # vintage `year` is the temporal key; no per-tile date
        "gsd": geo["gsd"],
        "proj_epsg": geo["proj_epsg"],
        "proj_bbox": geo["proj_bbox"],
        "proj_shape": geo["proj_shape"],
        "proj_transform": geo["proj_transform"],
        "band_count": geo["band_count"],
        "bands": geo["bands"],
    }


def process_cog_headers_generic(
    rows,
    max_workers=8,
    request_payer=None,
    access="public",
    aws_access_key_id=None,
    aws_secret_access_key=None,
):
    """Generic counterpart to process_manifest_cog_headers: read COG headers for an
    S3PrefixListing collection's rows.

    Access mode picks the S3 client: a PUBLIC bucket (e.g. KyFromAbove) must be
    read UNSIGNED -- a SIGNED request uses the caller's role, whose IAM doesn't
    grant that cross-account bucket, so S3 returns AccessDenied even though the
    bucket is world-readable. Anonymous (unsigned) requests hit only the bucket's
    public policy. request_payer is None for public buckets (no RequestPayer)."""
    results, failed = [], []
    if access == "public":
        from botocore import UNSIGNED
        from botocore.config import Config

        s3_client = boto3.client(
            "s3", config=Config(signature_version=UNSIGNED, max_pool_connections=max_workers)
        )
    else:
        from botocore.config import Config

        config = Config(max_pool_connections=max_workers)
        if aws_access_key_id and aws_secret_access_key:
            session = boto3.Session(
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                aws_session_token=None,
            )
            s3_client = session.client("s3", config=config)
        else:
            s3_client = boto3.client("s3", config=config)
    total = len(rows)
    print(f"Began COG header parsing for {total:,} selected assets...", flush=True)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(fetch_cog_geo_generic, s3_client, row, request_payer): row
            for row in rows.values()
        }
        for idx, future in enumerate(as_completed(futures), start=1):
            row = futures[future]
            try:
                results.append(future.result())
                if idx % 50 == 0 or idx == total:
                    print(f"Parsed COG headers: {idx}/{total} assets", flush=True)
            except Exception as e:
                failed.append((row["asset_href"], str(e)))
                print(f"Failed to parse COG header for {row['asset_href']}: {e}", flush=True)
    return results, failed

