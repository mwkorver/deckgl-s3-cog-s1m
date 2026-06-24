from functools import lru_cache
from typing import Any

from fastapi import HTTPException

from config import COLLECTION_ID, STATE_BBOXES


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
    ingestable = sorted(k for k, v in descriptors._REGISTRY.items() if v.discovery is not None)

    # Generic S3-prefix COG ingest only. NAIP (and any other non-registered
    # collection) is published read-only, so it has no ingest descriptor and
    # returns no ingestable states/strategies.
    try:
        disc = descriptors.get_descriptor(collection).discovery
        if disc is None:
            raise ValueError("Collection has no discovery adapter (read-only)")
    except (SystemExit, ValueError):
        return {"collection": collection, "collections": ingestable, "states": [], "strategies": []}

    states = []
    for r in (getattr(disc, "regions", ()) or ()):
        sb = STATE_BBOXES.get(r)
        if sb and not bboxes_intersect(bbox, sb):
            continue
        states.append({"state": r, "years": list(cached_available_years(collection, r))})
    strategies = [{"id": "manifest-cog-headers", "label": "COG headers", "available": True}]

    return {"collection": collection, "collections": ingestable, "states": states, "strategies": strategies}
