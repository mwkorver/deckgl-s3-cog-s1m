import type { RasterArray } from "./array.js";
import type { Tile } from "./tile.js";
/**
 * Options for {@link assembleTiles}.
 */
export interface AssembleTilesOptions {
    /** Total output width in pixels. */
    width: number;
    /** Total output height in pixels. */
    height: number;
    /** Tile width in pixels (all tiles must share this). */
    tileWidth: number;
    /** Tile height in pixels (all tiles must share this). */
    tileHeight: number;
    /** Column index of the leftmost tile in the grid. */
    minCol: number;
    /** Row index of the topmost tile in the grid. */
    minRow: number;
}
/**
 * Assemble multiple fetched tiles into a single {@link RasterArray}.
 *
 * Handles both pixel-interleaved and band-separate layouts, preserving the
 * original typed array type (e.g. `Float32Array`, `Uint16Array`). Masks are
 * assembled alongside data when present.
 *
 * The output array's `transform`, `crs`, and `nodata` are taken from the
 * top-left tile (the tile at `(minCol, minRow)`).
 *
 * @param tiles - Fetched tiles to assemble. Must form a contiguous rectangular
 *   grid and all share the same layout, band count, and typed array type.
 * @param opts - Describes the output grid dimensions and tile positions.
 * @returns A single {@link RasterArray} containing the assembled data.
 *
 * @see {@link AssembleTilesOptions}
 */
export declare function assembleTiles(tiles: Tile[], opts: AssembleTilesOptions): RasterArray;
//# sourceMappingURL=assemble.d.ts.map