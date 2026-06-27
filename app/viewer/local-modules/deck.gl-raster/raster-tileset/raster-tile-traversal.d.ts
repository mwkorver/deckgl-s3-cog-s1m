/**
 * This file implements tile traversal for generic 2D tilesets.
 *
 * The main algorithm works as follows:
 *
 * 1. Start at the root tile(s) (z=0, covers the entire image, but not
 *    necessarily the whole world)
 * 2. Test if each tile is visible using viewport frustum culling
 * 3. For visible tiles, compute distance-based LOD (Level of Detail)
 * 4. If LOD is insufficient, recursively subdivide into child tiles
 * 5. Select tiles at appropriate zoom levels based on distance from camera
 *
 * The result is a set of tiles at varying zoom levels that efficiently
 * cover the visible area with appropriate detail.
 *
 * The traversal is driven by a {@link RasterTilesetDescriptor}, which abstracts over
 * both OGC TileMatrixSet grids and Zarr multiscale pyramids.
 */
import type { Viewport } from "@deck.gl/core";
import { CullingVolume, OrientedBoundingBox } from "@math.gl/culling";
import { BoundingVolumeCache } from "./bounding-volume-cache.js";
import type { RasterTilesetDescriptor, RasterTilesetLevel } from "./tileset-interface.js";
import type { Bounds, TileIndex, ZRange } from "./types.js";
/**
 * Raster Tile Node - represents a single tile in a tileset pyramid.
 *
 * Akin to the upstream OSMNode class.
 *
 * This node class uses the following coordinate system:
 *
 * - x: tile column (0 to RasterTilesetLevel.matrixWidth, left to right)
 * - y: tile row (0 to RasterTilesetLevel.matrixHeight, top to bottom)
 * - z: overview level. This assumes ordering where: 0 = coarsest, higher = finer
 */
export declare class RasterTileNode {
    /** Index across a row */
    x: number;
    /** Index down a column */
    y: number;
    /** Zoom index assumed to be (higher = finer detail) */
    z: number;
    private descriptor;
    /**
     * Flag indicating whether any descendant of this tile is visible.
     *
     * Used to prevent loading parent tiles when children are visible (avoids
     * overdraw).
     */
    private childVisible?;
    /**
     * Flag indicating this tile should be rendered
     *
     * Set to `true` when this is the appropriate LOD for its distance from camera.
     */
    private selected?;
    /** A cache of the children of this node. */
    private _children?;
    constructor(x: number, y: number, z: number, { descriptor }: {
        descriptor: RasterTilesetDescriptor;
    });
    /** Get the level info for this tile's z index. */
    get level(): RasterTilesetLevel;
    /** Get the children of this node.
     *
     * Find all tiles at level this.z + 1 whose spatial extent overlaps this tile.
     *
     * A tileset pyramid is not guaranteed to be a quadtree — it is a stack of
     * independent grids. We find children by mapping the parent tile's CRS bounds
     * into the child grid using {@link RasterTilesetLevel.crsBoundsToTileRange}.
     */
    get children(): RasterTileNode[] | null;
    /**
     * Recursively traverse the tile pyramid to determine if this tile (or its
     * descendants) should be rendered.
     *
     * I.e. "Given this tile node, should I render this tile, or should I recurse
     * into its children?"
     *
     * The algorithm performs:
     * 1. Visibility culling - reject tiles outside the view frustum
     * 2. Bounds checking - reject tiles outside the specified geographic bounds
     * 3. LOD selection - choose appropriate zoom level based on distance from camera
     * 4. Recursive subdivision - if LOD is insufficient, test child tiles
     *
     * Additionally, there should never be overdraw, i.e. a tile should never be
     * rendered if any of its descendants are rendered.
     *
     * @returns true if this tile or any descendant is visible, false otherwise
     */
    update(params: {
        viewport: Viewport;
        project: ((xyz: number[]) => number[]) | null;
        cullingVolume: CullingVolume;
        elevationBounds: ZRange;
        /** Minimum (coarsest) overview level */
        minZ: number;
        /** Maximum (finest) overview level */
        maxZ?: number;
        /** Optional geographic bounds filter */
        bounds?: Bounds;
        /**
         * Device pixels per CSS pixel. The LOD test selects a tile when its
         * source pixels are at most one *device* pixel wide; on HiDPI displays
         * (`pixelRatio > 1`) this picks a finer overview than the CSS-pixel
         * comparison would. See `dev-docs/lod-and-pixel-matching.md` § (A).
         */
        pixelRatio: number;
        /**
         * Number of world copies to shift this tile's bounding volume by along
         * common-space X for frustum testing. Default `0` (primary world).
         * Non-zero passes are additive — they may set `selected = true` but
         * never override a previous `true` to `false`. See
         * `dev-docs/world-copies.md`.
         */
        worldOffset?: number;
        /**
         * Bounding-volume cache shared by every node in this traversal. Populated
         * lazily as tiles are visited; reused across `getTileIndices` calls (so
         * animation frames don't recompute proj4 reprojections + oriented-bounding-
         * box fits). See {@link BoundingVolumeCache}.
         */
        boundingVolumeCache: BoundingVolumeCache;
    }): boolean;
    /**
     * Collect all tiles marked as selected in the tree.
     * Recursively traverses the entire tree and gathers tiles where selected=true.
     *
     * @param result - Accumulator array for selected tiles
     * @returns Array of selected RasterTileNode tiles
     */
    getSelected(result?: RasterTileNode[]): RasterTileNode[];
    /**
     * Test if this tile intersects the specified bounds in Web Mercator space.
     * Used to filter tiles when only a specific geographic region is needed.
     *
     * @param bounds - [minX, minY, maxX, maxY] in Web Mercator units (0-512)
     * @returns true if tile overlaps the bounds
     */
    insideBounds(bounds: Bounds, commonSpaceBounds: Bounds): boolean;
    /**
     * The 3D bounding volume for this tile in deck.gl's common coordinate space,
     * used for frustum culling.
     *
     * Memoized in `boundingVolumeCache` (keyed by `z/x/y`): a tile's bounding
     * volume depends only on `(z, x, y, zRange)` for a given descriptor, so on a
     * cache hit it is returned without rerunning {@link computeBoundingVolume}'s
     * proj4 reprojections + oriented-bounding-box fit.
     *
     * For non-zero `worldOffset`, returns a translated copy (center shifted by
     * `worldOffset * TILE_SIZE` along common-space X) without polluting the
     * cache — the cache always stores the offset-0 volume. See
     * `dev-docs/world-copies.md`.
     *
     * @param zRange               Elevation `[min, max]` in common-space units.
     * @param project              Projection function for Globe view, or `null`
     *                             for Web Mercator common space.
     * @param boundingVolumeCache  Cache keyed by `z/x/y`. Stores the offset-0
     *                             volume only.
     * @param worldOffset          Number of world copies to translate the result
     *                             by along common-space X. `0` returns the
     *                             cached offset-0 volume directly. Non-zero
     *                             values return a fresh translated copy.
     */
    getBoundingVolume(zRange: ZRange, project: ((xyz: number[]) => number[]) | null, boundingVolumeCache: BoundingVolumeCache, worldOffset?: number): {
        boundingVolume: OrientedBoundingBox;
        commonSpaceBounds: Bounds;
    };
    /**
     * Compute (without caching) the 3D bounding volume for this tile in deck.gl's
     * common coordinate space.
     *
     * TODO: In the future, we can add a fast path in the case that the source
     * tiling is already in EPSG:3857.
     */
    private computeBoundingVolume;
    /**
     * Generic case - sample reference points and reproject to Web Mercator, then
     * convert to deck.gl common space
     *
     */
    private _getGenericBoundingVolume;
    /**
     * Globe-view bounding volume: reproject the tile's reference points to WGS84,
     * project them onto the globe sphere (`project` = `viewport.projectPosition`)
     * to build the oriented bounding box used for frustum culling, and separately
     * compute a Web-Mercator-world AABB for the `bounds` pre-filter in
     * {@link update} (which compares against `wgs84Bounds` in mercator world).
     *
     * NOTE: elevation is not modeled on globe yet — reference points are sampled
     * at the surface (z = 0). Flat rasters only. See
     * `dev-docs/specs/2026-05-21-globe-view-design.md`.
     */
    private _getGlobeBoundingVolume;
}
/**
 * Rescale positions from EPSG:3857 into deck.gl's common space
 *
 * Similar to the upstream code here:
 * https://github.com/visgl/deck.gl/blob/b0134f025148b52b91320d16768ab5d14a745328/modules/geo-layers/src/tileset-2d/tile-2d-traversal.ts#L172-L177
 */
export declare function rescaleEPSG3857ToCommonSpace([x, y]: [number, number]): [
    number,
    number
];
/**
 * Inverse of {@link rescaleEPSG3857ToCommonSpace}: rescale a deck.gl
 * common-space position back into EPSG:3857 meters.
 *
 * Common-space inputs are in-range by construction, so (unlike the forward
 * direction) no latitude clamp is applied.
 */
export declare function rescaleCommonSpaceToEPSG3857([x, y]: [number, number]): [
    number,
    number
];
/**
 * Build the list of root (z=0) `RasterTileNode`s for the traversal.
 *
 * Small root matrices (≤ {@link MAX_ROOT_TILES_NO_CULL}) are enumerated
 * directly — traditional pyramids with a 1×1 or 4×5 root grid skip any
 * projection work and keep bit-identical behavior to the pre-optimization
 * traversal.
 *
 * Large root matrices are culled to the intersection of the dataset extent
 * (`datasetWgs84Bounds`) and the viewport's WGS84 bounds, projected into
 * the source CRS via `transformBounds` (which densifies the edges so a
 * curving projection doesn't escape the 4-corner hull). If the viewport
 * and dataset don't overlap, an empty array is returned and the rest of
 * the traversal short-circuits.
 *
 * Exported for unit testing.
 */
export declare function createRootTiles(opts: {
    descriptor: RasterTilesetDescriptor;
    viewport: Pick<Viewport, "getBounds">;
    datasetWgs84Bounds: Bounds;
}): RasterTileNode[];
/**
 * Get tile indices visible in viewport.
 *
 * Uses frustum culling driven by a {@link RasterTilesetDescriptor}, which abstracts
 * over OGC TileMatrixSet grids and Zarr multiscale pyramids.
 *
 * Overview levels follow the descriptor ordering: index 0 = coarsest, higher = finer.
 */
export declare function getTileIndices(descriptor: RasterTilesetDescriptor, opts: {
    viewport: Viewport;
    maxZ: number;
    zRange: ZRange | null;
    wgs84Bounds: Bounds;
    /**
     * Device pixels per CSS pixel for the LOD criterion. Defaults to 1
     * (CSS-pixel-accurate selection). Pass deck.gl's
     * `device.canvasContext.cssToDeviceRatio()` for device-pixel accuracy
     * on HiDPI displays. See `dev-docs/lod-and-pixel-matching.md` § (A).
     */
    pixelRatio?: number;
    /**
     * Cache for tile bounding volumes, reused across `getTileIndices` calls so
     * repeated traversals (animation frames) don't redo the proj4 reprojections
     * + oriented-bounding-box fit. Pass the {@link BoundingVolumeCache} owned by
     * the `RasterTileset2D`. If omitted, a throwaway cache is used — it still
     * dedups within a single traversal but provides no cross-call benefit.
     */
    boundingVolumeCache?: BoundingVolumeCache;
}): TileIndex[];
//# sourceMappingURL=raster-tile-traversal.d.ts.map