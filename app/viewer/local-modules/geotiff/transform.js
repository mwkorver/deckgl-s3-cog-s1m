import { RasterTypeKey } from "@cogeotiff/core";
import { apply, compose, invert, translation } from "@s3-cog/affine";
export function createTransform({ modelTiepoint, modelPixelScale, modelTransformation, rasterType, }) {
    let transform;
    if (modelTiepoint && modelPixelScale) {
        transform = createFromModelTiepointAndPixelScale(modelTiepoint, modelPixelScale);
    }
    else if (modelTransformation) {
        transform = createFromModelTransformation(modelTransformation);
    }
    else {
        throw new Error("The image does not have an affine transformation.");
    }
    // Offset transform by half pixel for point-interpreted rasters.
    if (rasterType === RasterTypeKey.PixelIsPoint) {
        transform = compose(transform, translation(-0.5, -0.5));
    }
    return transform;
}
function createFromModelTiepointAndPixelScale(modelTiepoint, modelPixelScale) {
    const xOrigin = modelTiepoint[3];
    const yOrigin = modelTiepoint[4];
    const xResolution = modelPixelScale[0];
    const yResolution = -modelPixelScale[1];
    return [xResolution, 0, xOrigin, 0, yResolution, yOrigin];
}
function createFromModelTransformation(modelTransformation) {
    // ModelTransformation is a 4x4 matrix in row-major order
    // [0  1  2  3 ]   [a  b  0  c]
    // [4  5  6  7 ] = [d  e  0  f]
    // [8  9  10 11]   [0  0  1  0]
    // [12 13 14 15]   [0  0  0  1]
    const xOrigin = modelTransformation[3];
    const yOrigin = modelTransformation[7];
    const rowRotation = modelTransformation[1];
    const colRotation = modelTransformation[4];
    const xResolution = modelTransformation[0];
    const yResolution = modelTransformation[5];
    return [xResolution, rowRotation, xOrigin, colRotation, yResolution, yOrigin];
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
export function index(self, x, y, op = Math.floor) {
    const inv = invert(self.transform);
    const [col, row] = apply(inv, x, y);
    return [op(row), op(col)];
}
/**
 * Get the geographic (x, y) coordinate of the pixel at (row, col).
 *
 * @param row        Pixel row.
 * @param col        Pixel column.
 * @param offset     Which part of the pixel to return.  Defaults to "center".
 * @returns          [x, y] in the CRS.
 */
export function xy(self, row, col, offset = "center") {
    let c;
    let r;
    switch (offset) {
        case "center":
            c = col + 0.5;
            r = row + 0.5;
            break;
        case "ul":
            c = col;
            r = row;
            break;
        case "ur":
            c = col + 1;
            r = row;
            break;
        case "ll":
            c = col;
            r = row + 1;
            break;
        case "lr":
            c = col + 1;
            r = row + 1;
            break;
    }
    return apply(self.transform, c, r);
}
//# sourceMappingURL=transform.js.map