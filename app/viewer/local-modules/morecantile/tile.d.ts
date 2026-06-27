import type { BoundingBox, TileMatrix, TileMatrixSet } from "./types/index.js";
/**
 * Return the bounding box of the tile in the TMS's native coordinate reference
 * system.
 */
export declare function xy_bounds(matrix: TileMatrix, tile: {
    x: number;
    y: number;
}): BoundingBox;
/**
 * Return the bounding box of the tile in the TMS's native coordinate reference
 * system.
 */
export declare function xy_bounds(matrixSet: TileMatrixSet, tile: {
    x: number;
    y: number;
    z: number;
}): BoundingBox;
//# sourceMappingURL=tile.d.ts.map