/**
 * RasterTileset2D - Generic tile traversal over a tile pyramid with Frustum
 * Culling
 *
 * This version properly implements frustum culling and bounding volume calculations
 * following the pattern from deck.gl's OSM tile indexing.
 */
import type { Viewport } from "@deck.gl/core";
import type { GeoBoundingBox, _Tileset2DProps as Tileset2DProps } from "@deck.gl/geo-layers";
import { _Tileset2D as Tileset2D } from "@deck.gl/geo-layers";
import type { Matrix4 } from "@math.gl/core";
import type { RasterTilesetDescriptor } from "./tileset-interface.js";
import type { Corners, ProjectedBoundingBox, ProjectionFunction, TileIndex, ZRange } from "./types.js";
/** Type returned by {@link RasterTileset2D.getTileMetadata} */
export type RasterTileMetadata = {
    /**
     * **Axis-aligned** bounding box of the tile in **WGS84 coordinates**.
     */
    bbox: GeoBoundingBox;
    /**
     * **Axis-aligned** bounding box of the tile in **projected coordinates**.
     */
    projectedBbox: ProjectedBoundingBox;
    /**
     * "Rotated" bounding box of the tile in **projected coordinates**,
     * represented as four corners.
     *
     * This preserves rotation/skew information that would be lost in the
     * axis-aligned bbox.
     */
    projectedCorners: Corners;
    /**
     * Tile width in pixels.
     */
    tileWidth: number;
    /**
     * Tile height in pixels.
     */
    tileHeight: number;
    /**
     * Forward (tile-local pixel → CRS) transform for this tile.
     *
     * Stable across the tile's lifetime; computed once at tile creation. Stored
     * on the tile so downstream layers (e.g. `RasterTileLayer._renderSubLayers`)
     * receive a reference-stable function across renders, which is what
     * `RasterLayer`'s `reprojectionFnsChanged` check needs to avoid spurious mesh
     * regeneration.
     */
    forwardTransform: ProjectionFunction;
    /**
     * Inverse (CRS → tile-local pixel) transform.
     *
     * Same stability guarantees as {@link TileMetadata.forwardTransform}.
     */
    inverseTransform: ProjectionFunction;
    /**
     * Forward (source CRS → deck.gl common space) projection.
     *
     * Mirrors deck.gl's `Viewport.projectPosition` but for this descriptor's
     * source CRS rather than lng/lat. Descriptor-global (identical for every
     * tile) and built once on the tileset, so the reference is stable for the
     * tileset's lifetime — which is what `RasterLayer`'s `reprojectionFnsChanged`
     * check relies on to avoid regenerating the mesh every render.
     */
    _projectPosition: ProjectionFunction;
    /**
     * Inverse (deck.gl common space → source CRS) projection.
     *
     * Mirrors deck.gl's `Viewport.unprojectPosition`. Same stability guarantees
     * as {@link RasterTileMetadata._projectPosition}.
     */
    _unprojectPosition: ProjectionFunction;
};
/**
 * Configuration for a {@link RasterTileset2D}.
 */
export interface RasterTileset2DOptions {
    /**
     * Returns the current drawing-buffer-pixel/CSS-pixel ratio.
     *
     * Read at every `getTileIndices` call so that runtime changes (e.g. dragging
     * the window between displays of different DPR, or toggling
     * `Deck.useDevicePixels`) take effect on the next tile evaluation.
     *
     * Defaults to a constant `1` if omitted, which makes LOD selection
     * CSS-pixel-accurate but blurry on HiDPI displays. The `RasterTileLayer`
     * wires this to `drawingBufferWidth / cssWidth` read from the layer's
     * canvas context per call. See `dev-docs/lod-and-pixel-matching.md` § (A).
     */
    getPixelRatio?: () => number;
    /**
     * Soft cap on the number of tile bounding volumes cached across
     * `getTileIndices` calls. Bounding volumes are expensive to compute (proj4
     * reprojections + an oriented-bounding-box fit) and frame-invariant, so
     * caching them keeps repeated traversals (animation frames) cheap. See
     * `dev-docs/specs/2026-05-11-traversal-bounding-volume-cache-design.md`.
     *
     * @default 65536
     */
    maxBoundingVolumeCacheSize?: number;
}
/**
 * A generic tileset implementation organized according to the OGC
 * [TileMatrixSet](https://docs.ogc.org/is/17-083r4/17-083r4.html)
 * specification.
 *
 * Handles tile lifecycle, caching, and viewport-based loading.
 */
export declare class RasterTileset2D extends Tileset2D {
    private descriptor;
    private wgs84Bounds;
    private getPixelRatio;
    private boundingVolumeCache;
    private projectPosition;
    private unprojectPosition;
    /**
     * Projection mode of the viewport on the previous `getTileIndices` call.
     * `undefined` until the first call. Used to clear {@link boundingVolumeCache}
     * on a globe↔mercator switch (volumes are not valid across projection modes).
     */
    private lastViewportIsGlobe?;
    constructor(opts: Tileset2DProps, descriptor: RasterTilesetDescriptor, { getPixelRatio, maxBoundingVolumeCacheSize }?: RasterTileset2DOptions);
    /**
     * Get tile indices visible in viewport
     * Uses frustum culling similar to OSM implementation
     *
     * Overviews follow TileMatrixSet ordering: index 0 = coarsest, higher = finer
     *
     * `minZoom` and `maxZoom` gate against `viewport.zoom` (not the tileset
     * z-index, which is an overview level in our descriptor). When the
     * viewport zoom is outside these bounds this method returns an empty
     * list — no new tile fetches, and because deck.gl's `updateTileStates`
     * marks unselected cached tiles invisible, no rendering either.
     * `visibleMinZoom` / `visibleMaxZoom` (deck.gl 9.3+) are deliberately
     * not honored: their documented "fetch but don't render" semantic
     * requires a notion of clamping to a coarser z, which doesn't
     * generalize to descriptors with sparse or single overviews. See
     * `dev-docs/zoom-terminology.md` for the rationale.
     */
    getTileIndices(opts: {
        viewport: Viewport;
        maxZoom?: number;
        minZoom?: number;
        zRange: ZRange | null;
        modelMatrix?: Matrix4;
        modelMatrixInverse?: Matrix4;
    }): TileIndex[];
    /**
     * Sort tile indices by ascending distance from the viewport center in
     * projected (common/world) space so loads initiate center-out.
     *
     * Short-circuits when `tileIndices.length <= maxRequests` — all fetches
     * would start concurrently regardless of order in that case. Mutates and
     * returns `tileIndices`.
     */
    private sortTileIndicesByDistance;
    getTileId(index: TileIndex): string;
    getParentIndex(index: TileIndex): TileIndex;
    getTileZoom(index: TileIndex): number;
    getTileMetadata(index: TileIndex): RasterTileMetadata;
}
//# sourceMappingURL=raster-tileset-2d.d.ts.map