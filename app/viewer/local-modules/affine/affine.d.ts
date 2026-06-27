/**
 * Affine geotransform: `[a, b, c, d, e, f]`.
 *
 * Maps pixel (col, row) to geographic (x, y):
 *
 * ```
 * x = a * col + b * row + c
 * y = d * col + e * row + f
 * ```
 */
export type Affine = readonly [
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
];
/**
 * Access the identity affine transform, which maps pixel coordinates to
 * themselves.
 *
 * @return  The identity affine transform.
 */
export declare function identity(): Affine;
/**
 * Create a translation transform from an offset vector.
 *
 * @param xoff  Translation offset in x direction.
 * @param yoff  Translation offset in y direction.
 *
 * @return Transform that applies the given translation.
 */
export declare function translation(xoff: number, yoff: number): Affine;
/**
 * Create a scaling transform from a scalar or vector.
 *
 * You can pass either one or two scaling factors. Passing only a single scalar
 * value will scale in both dimensions equally. A vector scaling value scales
 * the dimensions independently.
 *
 * @param sx  Scaling factor in x direction.
 * @param sy  Scaling factor in y direction (defaults to sx if not provided).
 *
 * @return Transform that applies the given scaling.
 */
export declare function scale(sx: number, sy?: number): Affine;
/**
 * Create a rotation transform.
 *
 * Rotates counter-clockwise by `angle` degrees about the given pivot point
 * (defaults to the origin `(0, 0)`). Ported from the Python
 * [`affine`](https://github.com/rasterio/affine) library.
 *
 * @param angle  Rotation angle in degrees, counter-clockwise about the pivot.
 * @param pivot  Optional pivot point `[px, py]`. Defaults to `[0, 0]`.
 *
 * @return Transform that applies the given rotation.
 */
export declare function rotation(angle: number, pivot?: readonly [number, number]): Affine;
/**
 * Apply a geotransform to a coordinate.
 *
 * That is, we apply this series of equations:
 *
 * ```
 *  x_out = a * x + b * y + c
 *  y_out = d * x + e * y + f
 * ```
 *
 * @param affine  The affine transform to apply.
 * @param x       The x coordinate.
 * @param y       The y coordinate.
 *
 * @return The transformed coordinates.
 */
export declare function apply([a, b, c, d, e, f]: Affine, x: number, y: number): [x: number, y: number];
/**
 * Compose two affine transforms: A×B (apply B **first**, then A).
 *
 * This is equivalent to `a @ b` in Python's `affine` library, and is equivalent
 * to multiplying the 3×3 matrices:
 * ```
 *   | a1 b1 c1 |   | a2 b2 c2 |
 *   | d1 e1 f1 | × | d2 e2 f2 |
 *   | 0  0  1  |   | 0  0  1  |
 * ```
 *
 * @param A The first affine transform to apply.
 * @param B The second affine transform to apply.
 *
 * @return The composed affine transform.
 */
export declare function compose([a1, b1, c1, d1, e1, f1]: Affine, [a2, b2, c2, d2, e2, f2]: Affine): Affine;
/**
 * Compute the inverse of an Affine.
 *
 * @param affine  The affine transform to invert.
 * @return The inverted affine transform.
 * @throws If the transform is degenerate and cannot be inverted.
 */
export declare function invert([sa, sb, sc, sd, se, sf]: Affine): Affine;
/** Get the 'a' component of an Affine transform. */
export declare function a(affine: Affine): number;
/** Get the 'b' component of an Affine transform. */
export declare function b(affine: Affine): number;
/** Get the 'c' component of an Affine transform. */
export declare function c(affine: Affine): number;
/** Get the 'd' component of an Affine transform. */
export declare function d(affine: Affine): number;
/** Get the 'e' component of an Affine transform. */
export declare function e(affine: Affine): number;
/** Get the 'f' component of an Affine transform. */
export declare function f(affine: Affine): number;
//# sourceMappingURL=affine.d.ts.map