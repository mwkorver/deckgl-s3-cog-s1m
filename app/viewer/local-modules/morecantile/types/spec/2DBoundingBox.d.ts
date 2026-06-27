import type { DPoint } from "./2DPoint.js";
import type { CRS } from "./crs.js";
/**
 * Minimum bounding rectangle surrounding a 2D resource in the CRS indicated elsewhere
 */
export interface DBoundingBox {
    lowerLeft: DPoint;
    upperRight: DPoint;
    crs?: CRS;
    orderedAxes?: [string, string];
    [k: string]: unknown;
}
//# sourceMappingURL=2DBoundingBox.d.ts.map