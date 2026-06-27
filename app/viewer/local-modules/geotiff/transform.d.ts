import { RasterTypeKey } from "@cogeotiff/core";
import type { Affine } from "@s3-cog/affine";
export declare function createTransform({ modelTiepoint, modelPixelScale, modelTransformation, rasterType, }: {
    modelTiepoint: number[] | null;
    modelPixelScale: number[] | null;
    modelTransformation: number[] | null;
    rasterType: RasterTypeKey | null;
}): Affine;
/**
 * Interface for objects that have an affine transform.
 */
export interface HasTransform {
    /** The affine transform. */
    readonly transform: Affine;
}
/**
 * Get the (row, col) pixel index containing the geographic coordinate (x, y).
 *
 * @param x          x coordinate in the CRS.
 * @param y          y coordinate in the CRS.
 * @param op         Rounding function applied to fractional pixel indices.
 *                   Defaults to Math.floor.
 * @returns          [row, col] pixel indices.
 */
export declare function index(self: HasTransform, x: number, y: number, op?: (n: number) => number): [number, number];
/**
 * Get the geographic (x, y) coordinate of the pixel at (row, col).
 *
 * @param row        Pixel row.
 * @param col        Pixel column.
 * @param offset     Which part of the pixel to return.  Defaults to "center".
 * @returns          [x, y] in the CRS.
 */
export declare function xy(self: HasTransform, row: number, col: number, offset?: "center" | "ul" | "ur" | "ll" | "lr"): [number, number];
//# sourceMappingURL=transform.d.ts.map