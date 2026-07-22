from functools import lru_cache
from typing import Any

from config import COLLECTION_ID


@lru_cache(maxsize=64)
def cached_available_years(collection_id: str, region: str) -> tuple[int, ...]:
    import descriptors

    disc = descriptors.get_descriptor(collection_id).discovery
    if hasattr(disc, "available_years"):
        return tuple(disc.available_years(region))
    return tuple()


def build_ingest_options(body: dict[str, Any]):
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
        states.append({"state": r, "years": list(cached_available_years(collection, r))})

    if collection == "naip":
        strategies = [
            {"id": "manifest-cog-headers", "label": "COG headers", "available": True},
            {"id": "manifest-earthsearch", "label": "EarthSearch STAC", "available": True},
        ]
    else:
        strategies = [{"id": "manifest-cog-headers", "label": "COG headers", "available": True}]

    from config import LAKE_ROOT
    bucket_name = ""
    account_id = ""
    if LAKE_ROOT.startswith("s3://"):
        bucket_name = LAKE_ROOT[5:].split("/")[0]
        parts = bucket_name.split("-")
        if len(parts) >= 5:
            account_id = parts[4]

    return {
        "collection": collection,
        "collections": ingestable,
        "states": states,
        "strategies": strategies,
        "account_id": account_id,
        "bucket_name": bucket_name,
    }
