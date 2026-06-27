import type { RasterTilesetLevel } from "../raster-tileset/tileset-interface.js";
/**
 * UV transform mapping primary tile UV space to the correct sub-region of a
 * band texture.
 *
 * Applied in the shader as: `sampledUV = uv * [scaleX, scaleY] + [offsetX, offsetY]`
 *
 * Defined as a tuple so it can be uploaded directly to the GPU as a vec4 uniform.
 *
 * Elements:
 * - `offsetX` — horizontal offset: left edge of the primary tile within the band texture, in UV units
 * - `offsetY` — vertical offset: top edge of the primary tile within the band texture, in UV units
 * - `scaleX` — horizontal scale: fraction of the band texture width covered by the primary tile
 * - `scaleY` — vertical scale: fraction of the band texture height covered by the primary tile
 */
export type UvTransform = readonly [
    offsetX: number,
    offsetY: number,
    scaleX: number,
    scaleY: number
];
/**
 * A tile index in a secondary tileset.
 *
 * Uses `x`/`y` naming to match {@link TileIndex} convention.
 *
 * @see {@link SecondaryTileResolution}
 */
export interface SecondaryTileIndex {
    /** Column index of the secondary tile. */
    x: number;
    /** Row index of the secondary tile. */
    y: number;
}
/**
 * Result of resolving secondary tiles for a primary tile.
 *
 * @see {@link resolveSecondaryTiles}
 */
export interface SecondaryTileResolution {
    /**
     * The secondary tile indices that cover the primary tile's extent.
     *
     * When the primary tile falls within a single secondary tile, this array
     * has one element. When the primary tile straddles a boundary, it may
     * contain multiple entries that must be stitched together.
     */
    tileIndices: SecondaryTileIndex[];
    /**
     * UV transform: `[offsetX, offsetY, scaleX, scaleY]`.
     *
     * Maps from the primary tile's UV space [0,1]^2 to the correct sub-region
     * of the stitched secondary texture.
     *
     * Usage in shader: `sampledUV = uv * scale + offset`
     *
     * - `offsetX`, `offsetY`: top-left corner of the primary tile's footprint
     *   within the stitched texture, in UV units.
     * - `scaleX`, `scaleY`: fraction of the stitched texture covered by the
     *   primary tile.
     */
    uvTransform: UvTransform;
    /**
     * The total stitched texture width in pixels.
     *
     * Equals the number of tile columns in the covering range times the
     * secondary tile width. For example, if 2 tiles of 256px wide are
     * fetched, `stitchedWidth` is 512.
     */
    stitchedWidth: number;
    /**
     * The total stitched texture height in pixels.
     *
     * Equals the number of tile rows in the covering range times the
     * secondary tile height. For example, if 2 tiles of 256px tall are
     * fetched, `stitchedHeight` is 512.
     */
    stitchedHeight: number;
    /**
     * The minimum column index of the secondary tile range.
     *
     * Used when stitching: tells you where each fetched tile goes in the
     * stitched buffer (tile at column `col` starts at pixel
     * `(col - minCol) * tileWidth`).
     */
    minCol: number;
    /**
     * The minimum row index of the secondary tile range.
     *
     * Used when stitching: tells you where each fetched tile goes in the
     * stitched buffer (tile at row `row` starts at pixel
     * `(row - minRow) * tileHeight`).
     */
    minRow: number;
    /**
     * Zoom level index into {@link TilesetDescriptor.levels}.
     *
     * All tiles in {@link tileIndices} come from this same level. Tells the
     * consumer which COG overview to fetch from.
     */
    z: number;
}
/**
 * Resolve which secondary tiles cover a primary tile's extent, and compute
 * the UV transform to map from primary UV space into the stitched secondary
 * texture.
 *
 * The UV transform `[offsetX, offsetY, scaleX, scaleY]` is intended for use
 * in a shader as `sampledUV = uv * scale + offset`, where `uv` is the
 * primary tile's local UV coordinate in [0,1]^2.
 *
 * The Y axis follows a top-left convention: origin is at the top-left corner,
 * Y increases downward in texture/UV space. CRS coordinates may increase
 * upward (north), so `offsetY` is computed as
 * `(stitchedMaxY - primaryMaxY) / stitchedCrsHeight` to account for the flip.
 *
 * @param primaryLevel - The {@link RasterTilesetLevel} describing the primary tileset.
 * @param primaryCol - Column index of the primary tile.
 * @param primaryRow - Row index of the primary tile.
 * @param secondaryLevel - The {@link RasterTilesetLevel} describing the secondary tileset.
 * @param secondaryZ - The zoom level index of `secondaryLevel` within its
 *   {@link TilesetDescriptor.levels} array. Stored in the returned
 *   {@link SecondaryTileResolution.z} so the consumer knows which COG overview
 *   to fetch.
 * @returns A {@link SecondaryTileResolution} with tile indices, UV transform,
 *   stitched dimensions, and the min col/row of the covered range.
 */
export declare function resolveSecondaryTiles(primaryLevel: RasterTilesetLevel, primaryCol: number, primaryRow: number, secondaryLevel: RasterTilesetLevel, secondaryZ: number): SecondaryTileResolution;
//# sourceMappingURL=secondary-tile-resolver.d.ts.map