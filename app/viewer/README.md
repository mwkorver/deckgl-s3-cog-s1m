# S1M Terrain Draping Pipeline

This document describes how RODA Cloud-Optimized GeoTIFF (COG) aerial imagery is dynamically draped over the 3D Albers-projected S1M terrain mesh in the browser.

---

## The Step-by-Step Draping Lifecycle

Whenever a user interacts with the map, the application executes the following pipeline for each visible S1M tile:

### 1. Viewport Interaction & Debouncing
* When the user pans, zooms, or rotates the map, deck.gl registers the viewport change.
* A debounced listener waits for `300ms` of view stability and calls [`refreshS1MTerrain()`](index.html#L3869).

### 2. Fetching the Active S1M Grid
* [`refreshS1MTerrain()`](index.html#L3869) issues a request to the backend `/s1m/tiles` endpoint, passing the padded viewport bounding box.
* The API returns the list of active 3D terrain grid tiles (DEM files).
* The client sorts the returned tiles from the bottom of the viewport upward ([`sortS1MTilesBottomFirst()`](index.html#L3902)) so foreground terrain is processed and starts draping first.

### 3. Subdivision (Sub-tiling) Decision
* A single S1M grid tile spans a massive ~12 km footprint. To avoid stretching a single low-resolution texture across this area, the client splits each tile into an $N \times N$ grid of smaller sub-tiles ([`s1mSubdiv()`](index.html#L3259)).
* For collections with smaller-sized COG tiles like **New Jersey** (`nj-imagery`) or **Kentucky** (`kyfromabove`), [`isSmallCogCollection()`](index.html#L1862) returns `true`. This scales up subdivision aggressively, using a minimum subdivision level of $2 \times 2$ (~6 km sub-tiles) and up to $6 \times 6$ sub-tiles when zoomed in.

### 4. Querying Intersecting COGs (STAC Search)
* For each visible sub-tile, [`ensureSubTileDrape()`](index.html#L3382) queries the backend `/search` endpoint to find all imagery files that spatially cover the sub-tile:
  ```json
  {
    "collections": ["nj-imagery"],
    "bbox": [sub_tile_bbox]
  }
  ```
* The backend queries the DuckDB spatial Parquet data lake using spatial index boundaries (`ST_Intersects`) and returns metadata containing the raw `s3://` URLs of the matching COG files (e.g., `s3://njogis-imagery/2020/cog/A15B12.tif`).

### 5. S3 Endpoint Resolution & Tag Parsing
* The client passes the S3 path to [`resolveGeotiffSource()`](index.html#L1647). If asset signing is active, it requests a signed URL. For public buckets, it maps the path directly to the region-specific virtual-hosted S3 URL:
  `https://njogis-imagery.s3.us-west-2.amazonaws.com/2020/cog/A15B12.tif`
* The client-side `@s3-cog/geotiff` parser issues a few initial ranged HTTP `GET` requests to extract the TIFF tag headers (discovering metadata like `bitsPerSample`, internal overview levels, and coordinate system geokeys).

### 6. Selecting the Optimal Overview Level
* The client compares the span of the sub-tile bounding box with the span of the COG tile via [`chooseDrapeImageLevel()`](index.html#L3053).
* It dynamically picks the most appropriate low-resolution overview tier of the COG to avoid fetching full-resolution imagery for zoomed-out views.

### 7. Fetching & Decoding COG Tiles
* The client maps the sub-tile's corners to the COG overview coordinates using [`drapePixelMapper()`](index.html#L3017), which applies the inverse georeferencing matrix (`affine.invert(level.transform)`).
* The client requests the necessary internal tiles (e.g., $512 \times 512$ pixel blocks) using HTTP `Range` requests (`fetchTile`).
* Decoded tiles are stored in a Shared LRU Cache ([`s1mCogTileCache`](index.html#L2968)) so overlapping boundaries between sub-tiles share chunks instead of duplicating network requests.

### 8. 16-bit to 8-bit Color Transformation
* The decoded raw data is returned as a `Uint16Array` (for 16-bit imagery like New Jersey) or `Uint8Array`.
* [`displayDrapeRgbaBytes()`](index.html#L2911) uses [`collectionForHref()`](index.html#L908) to fetch the display range (`display: { domain: [domainMin, domainMax] }`) from the collection registry.
* Pixel intensities are converted line-by-line:
  $$\text{scaled} = \text{round}\left( \frac{\text{raw} - \text{domainMin}}{\text{domainMax} - \text{domainMin}} \times 255 \right)$$
* Transparent alpha values (`0`) are assigned to no-data pixels (like black collars), and standard pixels are given `255`.

### 9. Reprojection & Canvas Rasterization
* The client initializes a blank $384 \times 384$ canvas buffer via [`buildDrapeImage()`](index.html#L3229).
* For each coordinate $(u,v)$ in the canvas, [`paintDrapeSource()`](index.html#L3079):
  1. maps it to `[longitude, latitude]` using `bilinearCornerMapper`.
  2. reprojects the longitude/latitude coordinates into the **EPSG:6527 (New Jersey State Plane)** projected system (units in US survey feet) via `proj4`.
  3. applies the inverse transform to locate the exact source pixel in the decoded COG.
  4. writes the scaled RGBA values to the canvas.
* Because New Jersey COGs are small, this process repeats for up to 48 overlapping COG tile sources until the sub-tile canvas is fully covered.

### 10. WebGL Upload & Rendering
* The completed canvas buffer is packed into a WebGL-compatible `ImageData` object (`drapeImage`).
* [`buildS1MSubTileLayerGPU()`](index.html#L3454) instantiates a `TerrainMeshLayerClass` for deck.gl, linking:
  * the sub-grid elevation heights (`sub.elev`)
  * the 3D grid mesh (`sub.gpuMesh.mesh`)
  * the generated 8-bit rasterized texture (`drapeImage`)
* Deck.gl uploads the texture to the GPU and renders the final 3D terrain mesh draped with the New Jersey statewide imagery.

---

## Architectural Differences: NAIP vs. New Jersey Statewide

The draping pipeline dynamically adapts its behavior based on the active collection. Below is a comparison of how NAIP and New Jersey Statewide imagery are processed differently:

| Metric / Pipeline Phase | NAIP (National Agriculture Imagery Program) | New Jersey Statewide Digital Aerial Imagery |
| :--- | :--- | :--- |
| **Footprint Size** | **Large (~10 km)**<br>A single NAIP COG tile is roughly equivalent in size to a full S1M terrain tile (~12 km). | **Small (~1.5 km)**<br>A single S1M tile covers a grid of dozens of New Jersey COG tiles. |
| **Subdivision (Sub-tiling)** | **LOD-based (1 to 6)**<br>Can scale down to a subdivision of `1` (single drape image for the entire terrain tile) on zoom-out. | **Fine Grid (always $\ge 2$)**<br>To prevent rendering gaps and avoid fetching too many COGs at once, the minimum subdivision level is clamped to $2 \times 2$. |
| **Intersecting COG Cap** | **Low (6 to 12 sources)**<br>A sub-tile only requires a few large COGs to achieve full coverage. | **High (24 to 48 sources)**<br>A sub-tile requires many small COGs to fill the canvas. Standard caps are doubled to avoid "green gaps" (undraped fallback sections). |
| **Coordinate System (CRS)** | **UTM (Universal Transverse Mercator)**<br>Metric projection systems (e.g. EPSG:26916/26917) where coordinates are in meters. | **State Plane (EPSG:6527)**<br>The projection coordinates are in **US Survey Feet**. |
| **Reprojection Logic** | Standard degrees-to-meters projection via `proj4`. | Reprojects degrees-to-survey feet via `proj4`. The affine transform (`level.transform`) operates entirely in feet units. |
| **Bit Depth & Normalization** | **8-bit RGB/RGBA**<br>Standard browser-native byte arrays. Bypasses scaling calculations. | **16-bit Unsigned Integers**<br>Requires CPU re-scaling inside the browser to normalize values (`[0..65535] -> [0..255]`) before WebGL upload. |

