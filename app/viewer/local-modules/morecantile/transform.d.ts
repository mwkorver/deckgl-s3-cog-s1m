import type { Affine } from "@s3-cog/affine";
import type { TileMatrix } from "./types/index.js";
/**
 * Construct a single affine transform that maps pixel coordinates
 * within *any* tile of the matrix to CRS coordinates.
 *
 * Returns `null` when the matrix declares `variableMatrixWidths`,
 * because coalesced rows have a different X pixel size than the rest
 * and cannot be described by one transform.  Use {@link tileTransform}
 * in that case.
 *
 * Pixel (0, 0) is the top-left corner of tile (0, 0).  The column
 * pixel index runs across the full matrix:
 *   globalPixelCol = col * tileWidth  + pixelWithinTile_x
 *   globalPixelRow = row * tileHeight + pixelWithinTile_y
 */
export declare function matrixTransform(matrix: TileMatrix): Affine | null;
/**
 * Construct an affine transform for a single tile identified by its
 * column and row indices within the matrix.  Pixel (0, 0) is the
 * top-left corner of *this* tile.
 *
 * This is always possible: even when `variableMatrixWidths` is
 * present, each individual tile is a plain rectangular pixel grid
 * with a well-defined, axis-aligned footprint.  Coalescence only
 * stretches the tile in X; Y is unaffected.
 */
export declare function tileTransform(matrix: TileMatrix, tile: {
    col: number;
    row: number;
}): Affine;
//# sourceMappingURL=transform.d.ts.map