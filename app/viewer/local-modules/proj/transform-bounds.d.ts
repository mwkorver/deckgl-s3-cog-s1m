export type Point = [number, number];
export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];
export type ProjectionFunction = (x: number, y: number) => Point;
/**
 * Transform boundary densifying the edges to account for nonlinear
 * transformations along these edges and extracting the outermost bounds.
 *
 * @param project - function that maps (x, y) in source CRS to (x, y) in target CRS
 * @param left - min X in source CRS
 * @param bottom - min Y in source CRS
 * @param right - max X in source CRS
 * @param top - max Y in source CRS
 * @param options.densifyPts - number of intermediate points along each edge (default 21)
 * @returns [minX, minY, maxX, maxY] in the target CRS
 */
export declare function transformBounds(project: ProjectionFunction, left: number, bottom: number, right: number, top: number, options?: {
    densifyPts?: number;
}): Bounds;
//# sourceMappingURL=transform-bounds.d.ts.map