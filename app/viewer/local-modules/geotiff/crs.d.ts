import type { ProjJson } from "@s3-cog/proj";
import type { GeoKeyDirectory } from "./ifd.js";
/**
 * Parse a CRS from a GeoKeyDirectory.
 *
 * Returns the EPSG code as a number for EPSG-coded CRSes (letting the caller
 * decide how to resolve it), or a PROJJSON object built from the geo keys for
 * user-defined CRSes.
 */
export declare function crsFromGeoKeys(gkd: GeoKeyDirectory): number | ProjJson;
//# sourceMappingURL=crs.d.ts.map