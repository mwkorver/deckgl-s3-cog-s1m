import type { ProjectionFunction } from "./transform-bounds.js";
/**
 * Wrap a proj4 forward projection to EPSG:3857 so that it never returns NaN.
 *
 * proj4 returns [NaN, NaN] for points at the poles (lat = ±90°) because the
 * Mercator projection is undefined there. The wrapper falls back to:
 *   1. Project the input to WGS84 via `forwardTo4326`
 *   2. Clamp the latitude to the Web Mercator limit (±85.05°)
 *   3. Convert analytically from WGS84 to EPSG:3857
 *
 * This correctly handles any input CRS, not just EPSG:4326.
 *
 * NOTE: An identical copy of this function lives in `raster-tile-traversal.ts`.
 * The two packages cannot share code due to their dependency relationship
 * (deck.gl-geotiff depends on deck.gl-raster, not vice versa). If this logic
 * changes, update both copies.
 *
 * Perhaps in the future we'll make a `@s3-cog/projections` package to
 * hold shared projection utilities like this. *
 */
export declare function makeClampedForwardTo3857(forwardTo3857: ProjectionFunction, forwardTo4326: ProjectionFunction): ProjectionFunction;
//# sourceMappingURL=web-mercator.d.ts.map