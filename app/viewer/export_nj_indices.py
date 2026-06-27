import os
import sys
import json
from pathlib import Path

# Add app/api to PYTHONPATH so we can import app modules
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

# Set S1M_INDEX_URL environment variable before importing s1m
os.environ["S1M_INDEX_URL"] = "s3://cog-stac-viewer-495811053987-us-west-2/lake/s1m/S1M_Products.parquet"

import lake
import s1m
from app import make_stac_feature


def export_nj_imagery():
    print("Exporting New Jersey Statewide 2020 imagery footprints...")
    sql = """
      select
        source_bucket, source_key,
        ST_AsGeoJSON(geometry) as geom_json,
        bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
        acquisition_date, gsd, collection, region, year, properties,
        proj_epsg, proj_shape, proj_transform,
        asset_href
      from read_parquet('s3://cog-stac-viewer-495811053987-us-west-2/lake/collection=nj-imagery/region=nj/year=2020/*.parquet', hive_partitioning=true)
      order by source_key asc
    """
    
    rows = lake.lake_query(lambda cur: cur.execute(sql).fetchall())
    print(f"Retrieved {len(rows)} imagery footprints.")
    
    features = [make_stac_feature(row) for row in rows]
    geojson = {
        "type": "FeatureCollection",
        "features": features
    }
    
    out_dir = Path(os.environ.get("OUT_DIR", str(Path(__file__).parent)))
    out_path = out_dir / "nj_imagery_2020.geojson"
    with open(out_path, "w") as f:
        json.dump(geojson, f)
    print(f"Wrote {out_path} ({out_path.stat().st_size / 1024 / 1024:.2f} MB)")

def export_nj_dem():
    print("Exporting New Jersey S1M DEM tile footprints...")
    # Bounding box of New Jersey
    west, south, east, north = -75.6, 38.9, -73.9, 41.4
    
    # Override S1M index url to S3 if not set
    if "S1M_INDEX_URL" not in os.environ:
        os.environ["S1M_INDEX_URL"] = "s3://cog-stac-viewer-495811053987-us-west-2/lake/s1m/S1M_Products.parquet"
        
    tiles = s1m.cover_tiles(west, south, east, north, max_tiles=10000)
    print(f"Retrieved {len(tiles)} S1M tiles covering NJ.")
    
    out_dir = Path(os.environ.get("OUT_DIR", str(Path(__file__).parent)))
    out_path = out_dir / "nj_s1m.json"
    with open(out_path, "w") as f:
        json.dump(tiles, f)
    print(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.2f} KB)")

if __name__ == "__main__":
    export_nj_imagery()
    export_nj_dem()
    print("Export completed successfully.")
