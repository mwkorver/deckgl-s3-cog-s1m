import type { TileMatrixSet } from "@s3-cog/morecantile";
import type { GeoTIFF } from "./geotiff.js";
/**
 * A minimal projection definition compatible with what wkt-parser returns.
 *
 * This type extracts only the partial properties we need from the full
 * wkt-parser output.
 */
interface ProjectionDefinition {
    datum?: {
        /** Semi-major axis of the ellipsoid. */
        a: number;
    };
    a?: number;
    to_meter?: number;
    units?: string;
}
/**
 * Generate a Tile Matrix Set from a GeoTIFF file.
 *
 * Produces one TileMatrix per overview (coarsest first) plus a final entry
 * for the full-resolution level. The GeoTIFF must be tiled.
 *
 * This requires a crs definition that includes a `units` property, so that we
 * can convert pixel sizes to physical screen units. Use [`wkt-parser`] to parse
 * a WKT string or PROJJSON object, then pass the result as the `crs` argument.
 *
 * [`wkt-parser`]: https://github.com/proj4js/wkt-parser
 *
 * @see https://docs.ogc.org/is/17-083r4/17-083r4.html
 */
export declare function generateTileMatrixSet(geotiff: GeoTIFF, crs: ProjectionDefinition, { id }?: {
    id?: string;
}): TileMatrixSet;
export {};
//# sourceMappingURL=tile-matrix-set.d.ts.map