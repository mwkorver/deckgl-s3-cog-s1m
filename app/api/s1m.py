"""USGS 3DEP Seamless 1-meter (S1M) DEM access.

S1M is a CONUS-wide seamless 1 m DEM (NAD83(2011) Conus Albers / EPSG:6350,
NAVD88 heights) distributed as COG GeoTIFF + metadata pairs in the public USGS
bucket s3://prd-tnm/StagedProducts/Elevation/S1M/. The whole-collection tile
index is published as a compact Parquet file whose polygon footprints carry the
relative COG path per tile in the `dataset` column.

This module is the read path for *terrain meshing* (not imagery): it resolves
which DEM tile covers a point, then reads a downsampled elevation grid the viewer
turns into a 3D mesh. The bucket is public (anonymous S3), so reads need no creds
-- distinct from the requester-pays NAIP path in app.py.
"""

import base64
import os
import threading

# Public USGS TNM distribution bucket -- anonymous reads.
S1M_BUCKET = "prd-tnm"
S1M_INDEX_URL = os.environ.get(
    "S1M_INDEX_URL",
    "/cache/s1m/S1M_Products.parquet",
)
S1M_EPSG = 6350  # NAD83(2011) Conus Albers
NODATA = -999999.0

_lock = threading.Lock()
_reader = None


def _open_reader() -> dict:
    import duckdb
    from pyproj import Transformer

    import duckdb_s3

    con = duckdb.connect(":memory:")
    duckdb_s3.configure(con, S1M_INDEX_URL, spatial=False)
    return {
        "con": con,
        "to_albers": Transformer.from_crs(4326, S1M_EPSG, always_xy=True),
        "to_4326": Transformer.from_crs(S1M_EPSG, 4326, always_xy=True),
    }


def get_reader():
    """Reuse one DuckDB connection and coordinate transformer per warm runtime."""
    global _reader
    if _reader is not None:
        return _reader
    with _lock:
        if _reader is None:
            _reader = _open_reader()
        return _reader


def cover_dataset(lon: float, lat: float) -> str | None:
    """The s3:// COG href of the S1M tile covering (lon, lat), or None."""
    reader = get_reader()
    x, y = reader["to_albers"].transform(lon, lat)
    escaped_url = S1M_INDEX_URL.replace("'", "''")
    candidates = reader["con"].execute(
        f"""
        SELECT dataset, geometry_wkb
        FROM read_parquet('{escaped_url}')
        WHERE bbox_xmin <= ? AND bbox_xmax >= ?
          AND bbox_ymin <= ? AND bbox_ymax >= ?
        """,
        [x, x, y, y],
    ).fetchall()

    from shapely import from_wkb
    from shapely.geometry import Point

    pt = Point(x, y)
    for dataset, geometry_wkb in candidates:
        if from_wkb(geometry_wkb).covers(pt):
            return f"s3://{S1M_BUCKET}/StagedProducts/Elevation/{dataset}"
    return None


def cover_tiles(west: float, south: float, east: float, north: float,
                max_tiles: int = 24, order_center: tuple[float, float] | None = None) -> list[dict]:
    """All S1M tiles intersecting a lon/lat bbox, nearest-to-centre first.

    Used to fill the viewport with terrain. The bbox columns make this a cheap
    range query; the lon/lat bbox is transformed to an Albers envelope (its 4
    corners -> min/max, a slight overestimate that just admits a few edge tiles).
    `order_center` (lon, lat) sets the point tiles are ordered nearest-to-first;
    pass the viewport centre so the centre-out fill starts where the viewer is
    looking. On a tilted view the bbox envelope centre sits far forward (the
    visible trapezoid reaches the horizon), so it's a poor focal point -- the
    viewport centre is much closer to the foreground. Falls back to the bbox
    centre. Returns [{dataset, center_lnglat, bbox}].
    """
    reader = get_reader()
    to_albers, to_4326 = reader["to_albers"], reader["to_4326"]
    xs, ys = [], []
    for lon, lat in [(west, south), (east, south), (east, north), (west, north)]:
        x, y = to_albers.transform(lon, lat)
        xs.append(x)
        ys.append(y)
    axmin, axmax, aymin, aymax = min(xs), max(xs), min(ys), max(ys)
    if order_center is not None:
        cx, cy = to_albers.transform(order_center[0], order_center[1])
    else:
        cx, cy = (axmin + axmax) / 2, (aymin + aymax) / 2
    escaped_url = S1M_INDEX_URL.replace("'", "''")
    rows = reader["con"].execute(
        f"""
        SELECT dataset, bbox_xmin, bbox_xmax, bbox_ymin, bbox_ymax, geometry_wkb
        FROM read_parquet('{escaped_url}')
        WHERE bbox_xmin <= ? AND bbox_xmax >= ?
          AND bbox_ymin <= ? AND bbox_ymax >= ?
        ORDER BY (((bbox_xmin + bbox_xmax) / 2 - ?) * ((bbox_xmin + bbox_xmax) / 2 - ?))
               + (((bbox_ymin + bbox_ymax) / 2 - ?) * ((bbox_ymin + bbox_ymax) / 2 - ?)),
               dataset
        """,
        [axmax, axmin, aymax, aymin, cx, cx, cy, cy],
    ).fetchall()
    from shapely import from_wkb
    from shapely.geometry import box

    viewport = box(axmin, aymin, axmax, aymax)
    tiles = []
    for dataset, xmin, xmax, ymin, ymax, geometry_wkb in rows:
        if not from_wkb(geometry_wkb).intersects(viewport):
            continue
        clon, clat = to_4326.transform((xmin + xmax) / 2, (ymin + ymax) / 2)
        west, south = to_4326.transform(xmin, ymin)
        east, north = to_4326.transform(xmax, ymax)
        tiles.append({
            "dataset": f"s3://{S1M_BUCKET}/StagedProducts/Elevation/{dataset}",
            "center_lnglat": [clon, clat],
            "bbox": [
                min(west, east),
                min(south, north),
                max(west, east),
                max(south, north),
            ],
        })
        if len(tiles) >= int(max_tiles):
            break
    return tiles


def read_terrain(dataset_s3: str, size: int = 256) -> dict:
    """Read a downsampled `size`x`size` elevation grid for the whole DEM tile.

    Returns the grid (base64 float32, row-major, NW-origin), the ground step in
    Albers metres per grid cell, the tile centre in lon/lat (the mesh anchor),
    and the valid elevation range. The viewer builds a METER_OFFSETS mesh from
    this: ENU x/y = (col - (W-1)/2)*dx, ((H-1)/2 - row)*|dy|, z = elevation.
    """
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.env import Env
    from pyproj import Geod, Transformer

    vsi = "/vsis3/" + dataset_s3[len("s3://"):]
    with Env(AWS_NO_SIGN_REQUEST="YES", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(vsi) as ds:
            arr = ds.read(1, out_shape=(size, size), resampling=Resampling.bilinear).astype("float32")
            # Vertex grid step: make the mesh span the full tile extent. Using
            # span / size treats samples like cell centers and shrinks every
            # tile by one cell, which leaves visible gaps between adjacent DEMs.
            dx = (ds.width * ds.transform.a) / max(size - 1, 1)   # +east, metres
            dy = (ds.height * ds.transform.e) / max(size - 1, 1)  # -north (e<0), metres
            # Tile centre in Albers -> lon/lat anchor.
            cx = ds.transform.c + (ds.width / 2) * ds.transform.a
            cy = ds.transform.f + (ds.height / 2) * ds.transform.e
            nd = ds.nodata if ds.nodata is not None else NODATA

    arr[arr == nd] = np.nan
    valid = arr[np.isfinite(arr)]
    to_4326 = Transformer.from_crs(S1M_EPSG, 4326, always_xy=True)
    clon, clat = to_4326.transform(cx, cy)

    # Albers is equal-area, so its linear scale is anisotropic (one axis stretched,
    # the other compressed, product ~1). The mesh is laid out in Albers metres but
    # rendered as true ground metres (METER_OFFSETS), so without correction tiles
    # fall short on one axis and overlap on the other -> seams. Convert the Albers
    # cell step to true ground metres per axis by measuring the geodesic distance of
    # a 1 km Albers step in east and north, so adjacent tiles abut exactly.
    geod = Geod(ellps="GRS80")  # NAD83(2011) ellipsoid
    D = 1000.0
    lon_e, lat_e = to_4326.transform(cx + D, cy)
    lon_n, lat_n = to_4326.transform(cx, cy + D)
    scale_east = geod.inv(clon, clat, lon_e, lat_e)[2] / D
    scale_north = geod.inv(clon, clat, lon_n, lat_n)[2] / D

    # Serialize as float32 with NaN -> sentinel so the viewer can mask voids.
    out = np.where(np.isfinite(arr), arr, NODATA).astype("<f4")
    return {
        "width": size,
        "height": size,
        "step": [abs(dx) * scale_east, abs(dy) * scale_north],  # true ground metres/cell (east, north)
        "center_lnglat": [clon, clat],
        "nodata": NODATA,
        "z_range": [float(valid.min()), float(valid.max())] if valid.size else [0.0, 0.0],
        "epsg": S1M_EPSG,
        "elev_b64": base64.b64encode(out.tobytes()).decode("ascii"),
    }
