"""USGS 3DEP Seamless 1-meter (S1M) DEM access.

S1M is a CONUS-wide seamless 1 m DEM (NAD83(2011) Conus Albers / EPSG:6350,
NAVD88 heights) distributed as COG GeoTIFF + metadata pairs in the public USGS
bucket s3://prd-tnm/StagedProducts/Elevation/S1M/. The whole-collection tile
index is published as a compact Parquet file whose polygon footprints carry the
relative COG path per tile in the `dataset` column.

This module is the terrain *tile discovery* path (not imagery): it resolves which
DEM tiles cover a viewport (`cover_tiles`) or a point (`cover_dataset`), returning
each tile's COG href + lon/lat footprint. The viewer reads the elevation grid from
the COG directly in the browser and builds the 3D mesh client-side. The bucket is
public (anonymous S3), so reads need no creds -- distinct from the requester-pays
NAIP path in app.py.
"""

import os
import threading

# Public USGS TNM distribution bucket -- anonymous reads.
S1M_BUCKET = "prd-tnm"
S1M_INDEX_URL = os.environ.get(
    "S1M_INDEX_URL",
    "/cache/s1m/S1M_Products.parquet",
)
S1M_EPSG = 6350  # NAD83(2011) Conus Albers

_lock = threading.Lock()
_reader = None


def _open_reader() -> dict:
    import duckdb
    import duckdb_s3
    from pyproj import Transformer

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
                max_tiles: int | None = 24, order_center: tuple[float, float] | None = None) -> list[dict]:
    """All S1M tiles intersecting a lon/lat bbox, nearest-to-centre first.

    Used to fill the viewport with terrain. The bbox columns make this a cheap
    range query; the lon/lat bbox is transformed to an Albers envelope (its 4
    corners -> min/max, a slight overestimate that just admits a few edge tiles).
    `order_center` (lon, lat) sets the point tiles are ordered nearest-to-first;
    pass the viewport centre so the centre-out fill starts where the viewer is
    looking. On a tilted view the bbox envelope centre sits far forward (the
    visible trapezoid reaches the horizon), so it's a poor focal point -- the
    viewport centre is much closer to the foreground. Falls back to the bbox
    centre. Returns [{dataset, center_lnglat, bbox, footprint}], where footprint
    is one or more lon/lat exterior rings for display.
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
    from shapely.ops import transform as shapely_transform

    viewport = box(axmin, aymin, axmax, aymax)
    tiles = []
    for dataset, xmin, xmax, ymin, ymax, geometry_wkb in rows:
        geom = from_wkb(geometry_wkb)
        if not geom.intersects(viewport):
            continue
        geom_4326 = shapely_transform(lambda x, y, z=None: to_4326.transform(x, y), geom)
        clon, clat = to_4326.transform((xmin + xmax) / 2, (ymin + ymax) / 2)
        w, s, e, n = geom_4326.bounds
        polys = [geom_4326] if geom_4326.geom_type == "Polygon" else list(getattr(geom_4326, "geoms", []))
        rings = []
        for poly in polys:
            if poly.geom_type != "Polygon" or poly.is_empty:
                continue
            rings.append([[float(lon), float(lat)] for lon, lat in poly.exterior.coords])
        tiles.append({
            "dataset": f"s3://{S1M_BUCKET}/StagedProducts/Elevation/{dataset}",
            "center_lnglat": [clon, clat],
            "bbox": [w, s, e, n],
            "footprint": rings,
        })
        if max_tiles is not None and len(tiles) >= int(max_tiles):
            break
    return tiles
