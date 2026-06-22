"""Dedicated Lambda API for USGS S1M terrain lookup and grid reads."""

import os
from secrets import compare_digest

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import s1m


def require_demo_token(
    x_demo_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
):
    expected = os.environ.get("S1M_DEMO_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="S1M demo token is not configured.")

    supplied = x_demo_token or ""
    if not supplied and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            supplied = value

    if not supplied or not compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing S1M demo token.")


app = FastAPI(
    title="COG STAC S1M terrain API",
    dependencies=[Depends(require_demo_token)],
)

# Allow the browser viewer to call this service cross-origin. By default only
# localhost (any scheme/port) is allowed -- enough for local dev where the
# viewer and this service run on different ports; in production the viewer is
# typically same-origin (CloudFront), but set S1M_CORS_ORIGIN_REGEX to permit a
# specific deployed origin if needed. CORSMiddleware answers the preflight
# OPTIONS before the token dependency, so preflight succeeds without the token
# and the actual request still carries x-demo-token.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=os.environ.get(
        "S1M_CORS_ORIGIN_REGEX", r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
    ),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type", "x-demo-token", "authorization"],
)


class TerrainRequest(BaseModel):
    lon: float | None = None
    lat: float | None = None
    size: int = 256
    dataset: str | None = None


class TilesRequest(BaseModel):
    bbox: list[float]  # [west, south, east, north] in lon/lat
    max_tiles: int | None = 24
    center: list[float] | None = None  # [lon, lat] viewport centre for nearest-first ordering


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/s1m/tiles")
def tiles(req: TilesRequest):
    """S1M tiles intersecting a lon/lat bbox (nearest-to-centre first) so the
    viewer can fill the viewport with terrain and draw exact footprint rings.
    The viewer fetches each grid via /s1m/terrain."""
    if len(req.bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox must be [west, south, east, north].")
    order_center = tuple(req.center) if req.center and len(req.center) == 2 else None
    try:
        west, south, east, north = req.bbox
        max_tiles = None if req.max_tiles is None else max(1, min(int(req.max_tiles), 10000))
        found = s1m.cover_tiles(
            west, south, east, north,
            max_tiles=max_tiles,
            order_center=order_center,
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"S1M index unavailable: {exc}") from exc
    return {"tiles": found}


@app.post("/s1m/terrain")
def terrain(req: TerrainRequest):
    try:
        if req.dataset:
            href = req.dataset
        elif req.lon is not None and req.lat is not None:
            href = s1m.cover_dataset(req.lon, req.lat)
        else:
            raise HTTPException(status_code=400, detail="Either dataset or lon/lat is required.")
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=503, detail=f"S1M index unavailable: {exc}") from exc
    if not href:
        raise HTTPException(
            status_code=404,
            detail=f"No S1M DEM tile covers ({req.lon}, {req.lat}).",
        )
    try:
        data = s1m.read_terrain(href, size=max(16, min(int(req.size), 512)))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"S1M terrain read failed: {exc}") from exc
    data["dataset"] = href
    return data


try:
    from mangum import Mangum

    handler = Mangum(app)
except ImportError:
    handler = None
