from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from aws_s3 import get_s3_client
from config import COLLECTION_ID, MANIFEST_INDEX, STATE_BBOXES
from lake import lake_years_for_states


@lru_cache(maxsize=1)
def load_manifest_states_years() -> dict[str, set[int]]:
    """State->years universe of ingestable NAIP data from manifest index partitions."""
    manifest_map: dict[str, set[int]] = {}
    root = str(MANIFEST_INDEX)
    try:
        if root.startswith("s3://"):
            bucket, _, prefix = root[len("s3://") :].partition("/")
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
                                    manifest_map.setdefault(state, set()).add(int(yseg.split("=", 1)[1]))
                                except ValueError:
                                    pass
        else:
            for sdir in Path(root).glob("state=*"):
                state = sdir.name.split("=", 1)[1].strip().lower()
                for ydir in sdir.glob("naip_year=*"):
                    try:
                        manifest_map.setdefault(state, set()).add(int(ydir.name.split("=", 1)[1]))
                    except ValueError:
                        pass
    except Exception as exc:
        print(f"Error listing manifest index {root}: {exc}", flush=True)
    return manifest_map


def bboxes_intersect(box1: list[float], box2: list[float]) -> bool:
    minx1, miny1, maxx1, maxy1 = box1
    minx2, miny2, maxx2, maxy2 = box2
    if (maxx1 - minx1) >= 360 or minx1 > maxx1:
        return not (maxy1 < miny2 or miny1 > maxy2)
    return not (maxx1 < minx2 or minx1 > maxx2 or maxy1 < miny2 or miny1 > maxy2)


@lru_cache(maxsize=64)
def cached_available_years(collection_id: str, region: str) -> tuple[int, ...]:
    import descriptors

    disc = descriptors.get_descriptor(collection_id).discovery
    if hasattr(disc, "available_years"):
        return tuple(disc.available_years(region))
    return tuple()


def build_ingest_options(body: dict[str, Any]):
    bbox = body.get("bbox")
    if not bbox or len(bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox is required and must be [minx, miny, maxx, maxy]")

    import descriptors

    collection = "".join(ch for ch in str(body.get("collection", COLLECTION_ID)).lower() if ch.isalnum() or ch in "-_")
    collection = collection or COLLECTION_ID
    ingestable = sorted(descriptors._REGISTRY)

    if collection == COLLECTION_ID:
        manifest_map = load_manifest_states_years()
        es_states: dict[str, set[int]] = {}
        for state, state_bbox in STATE_BBOXES.items():
            if bboxes_intersect(bbox, state_bbox) and state in manifest_map:
                es_states[state] = set(manifest_map[state])
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
        try:
            disc = descriptors.get_descriptor(collection).discovery
        except SystemExit:
            raise HTTPException(status_code=400, detail=f"unknown collection '{collection}'")
        states = []
        for r in (getattr(disc, "regions", ()) or ()):
            sb = STATE_BBOXES.get(r)
            if sb and not bboxes_intersect(bbox, sb):
                continue
            states.append({"state": r, "years": list(cached_available_years(collection, r))})
        strategies = [{"id": "manifest-cog-headers", "label": "COG headers", "available": True}]

    return {"collection": collection, "collections": ingestable, "states": states, "strategies": strategies}
