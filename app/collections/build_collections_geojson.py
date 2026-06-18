"""Compile registry.yaml -> collections.geojson for the viewer's map lookup.

The registry (layer 0) is the curated source of truth pairing each collection's
spatial extent with its ingest descriptor. The viewer only needs the extent half,
as a tiny GeoJSON it can intersect against the viewport client-side ("which
collections cover where I'm looking?"). This script extracts that.

  registry.yaml  --(this)-->  api/viewer/collections.geojson  --(deploy-viewer)--> S3

One Polygon feature per collection (a rectangle from extent.bbox -- coarse, the
"fast-path intersect" the design calls for; precise state polygons can come later
from region_code). Collections with no COG product (status excluded-not-cog) are
omitted -- they aren't usable imagery. Active + parked are kept so the viewer can
show "available here" even for region-deferred ones.

Run:  .venv/bin/python collections/build_collections_geojson.py
"""

import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / "registry.yaml"
OUT = HERE.parent / "viewer" / "collections.geojson"


def bbox_to_polygon(b):
    """[minlon, minlat, maxlon, maxlat] -> a closed GeoJSON ring."""
    minx, miny, maxx, maxy = b
    return [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]]


def main():
    reg = yaml.safe_load(REGISTRY.read_text())
    feats = []
    for c in reg.get("collections", []):
        if c.get("status") == "excluded-not-cog":
            continue  # no COG product -> not usable imagery, omit from the map
        ext = c.get("extent") or {}
        bbox = ext.get("bbox")
        if not bbox:
            continue
        src = c.get("source") or {}
        feats.append({
            "type": "Feature",
            "properties": {
                "id": c["id"],
                "title": c.get("title", c["id"]),
                "active": bool(c.get("active")),
                "status": c.get("status"),
                "region_kind": ext.get("region_kind"),
                "region_code": ext.get("region_code"),
                "years": ext.get("years"),
                "bucket": src.get("bucket"),
                "bucket_region": src.get("bucket_region"),
                "access": src.get("access"),
                "cog_verified": bool(c.get("cog_verified")),
                "display": c.get("display"),
                "bbox": bbox,
            },
            "geometry": {"type": "Polygon", "coordinates": bbox_to_polygon(bbox)},
        })

    fc = {
        "type": "FeatureCollection",
        "generated_from": "collections/registry.yaml (do not edit by hand)",
        "features": feats,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fc, indent=2) + "\n")
    active = sum(1 for f in feats if f["properties"]["active"])
    print(f"wrote {OUT}")
    print(f"  {len(feats)} collections ({active} active, {len(feats) - active} parked)")


if __name__ == "__main__":
    main()
