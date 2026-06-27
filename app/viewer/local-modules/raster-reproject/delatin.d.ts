/**
 * Define [**uv coordinates**](https://en.wikipedia.org/wiki/UV_mapping) as a float-valued image-local coordinate space where the top left is `(0, 0)` and the bottom right is `(1, 1)`.
 *
 * Define [**Barycentric coordinates**](https://en.wikipedia.org/wiki/Barycentric_coordinate_system) as float-valued triangle-local coordinates, represented as a 3-tuple of floats, where the tuple must add up to 1. The coordinate represents "how close to each vertex" a point in the interior of a triangle is. I.e. `(0, 0, 1)`, `(0, 1, 0)`, and `(1, 0, 0)`  are all valid barycentric coordinates that define one of the three vertices. `(1/3, 1/3, 1/3)` represents the centroid of a triangle. `(1/2, 1/2, 0)` represents a point that is halfway between vertices `a` and `b` and has "none" of vertex `c`.
 *
 *
 * ## Changes
 *
 * - Delatin coordinates are in terms of pixel space whereas here we use uv space.
 *
 * Originally copied from https://github.com/mapbox/delatin under the ISC
 * license, then subject to further modifications.
 */
export interface ReprojectionFns {
    /**
     * Convert from UV coordinates to input CRS coordinates.
     *
     * This is the affine geotransform from the input image.
     */
    forwardTransform(x: number, y: number): [number, number];
    /**
     * Convert from input CRS coordinates back to UV coordinates.
     *
     * Inverse of the affine geotransform from the input image.
     */
    inverseTransform(x: number, y: number): [number, number];
    /**
     * Apply the forward projection from input CRS to output CRS.
     */
    forwardReproject(x: number, y: number): [number, number];
    /**
     * Apply the inverse projection from output CRS back to input CRS.
     */
    inverseReproject(x: number, y: number): [number, number];
}
/**
 * RasterReprojector performs a Delaunay triangulation-based reprojection of a
 * raster image.
 *
 * It takes as input a set of functions to associate pixel positions with
 * coordinates in the input and output CRS, as well as the dimensions of the
 * output image, and it produces a triangulated mesh that can be used to
 * reproject the input raster onto the output raster with bounded error.
 */
export declare class RasterReprojector {
    reprojectors: ReprojectionFns;
    /** Width of the image in pixels */
    width: number;
    /** Height of the image in pixels */
    height: number;
    /**
     * UV vertex coordinates (x, y), i.e.
     * [x0, y0, x1, y1, ...]
     *
     * These coordinates are floats that range from [0, 1] in both X and Y.
     */
    uvs: number[];
    /**
     * XY Positions in output CRS, computed via exact forward reprojection.
     */
    exactOutputPositions: number[];
    /**
     * triangle vertex indices
     */
    triangles: number[];
    private _halfedges;
    /**
     * The UV texture coordinates of candidates found from
     * `findReprojectionCandidate`.
     *
     * Maybe in the future we'll want to store the barycentric coordinates instead
     * of just the uv coordinates?
     */
    private _candidatesUV;
    private _queueIndices;
    private _queue;
    private _errors;
    private _pending;
    private _pendingLen;
    constructor(reprojectors: ReprojectionFns, width: number, height?: number);
    /**
     * Refine the mesh until its maximum error gets below the given one
     *
     * @param maxError The maximum reprojection error in input pixels that the mesh should achieve.
     * @param maxIterations Optional safeguard to prevent infinite loops in case of non-convergence. If the mesh fails to converge within this number of iterations, a warning will be logged and the function will return early.
     *
     * @return  {[type]}  [return description]
     */
    run(maxError?: number, { maxIterations }?: {
        maxIterations?: number | undefined;
    }): void;
    refine(): void;
    getMaxError(): number;
    private _flush;
    /**
     * Conversion of upstream's `_findCandidate` for reprojection error handling.
     *
     * @param t The index (into `this.triangles`) of the pending triangle to process.
     *
     * @return Doesn't return; instead modifies internal state.
     */
    private _findReprojectionCandidate;
    private _step;
    private _addPoint;
    private _addTriangle;
    private _legalize;
    private _handleCollinear;
    private _queuePush;
    private _queuePop;
    private _queuePopBack;
    private _queueRemove;
    private _queueLess;
    private _queueSwap;
    private _queueUp;
    private _queueDown;
}
//# sourceMappingURL=delatin.d.ts.map