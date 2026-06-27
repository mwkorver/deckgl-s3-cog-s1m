import type { ConcurrencyLimiter, Priority, RasterArray } from "@s3-cog/geotiff";
import { GeoTIFF } from "@s3-cog/geotiff";
import type { Converter } from "proj4";
/**
 * Add an alpha channel to an RGB image array.
 *
 * Only supports input arrays with 3 (RGB) or 4 (RGBA) channels. If the input is
 * already RGBA, it is returned unchanged.
 */
export declare function addAlphaChannel(rgbImage: RasterArray): RasterArray;
export declare function fetchGeoTIFF(input: GeoTIFF | string | URL | ArrayBuffer, options?: {
    headers?: Record<string, string>;
    concurrencyLimiter?: ConcurrencyLimiter | null;
    getPriority?: () => Priority;
    signal?: AbortSignal;
}): Promise<GeoTIFF>;
/**
 * Calculate the WGS84 bounding box of a GeoTIFF image
 */
export declare function getGeographicBounds(geotiff: GeoTIFF, converter: Converter): {
    west: number;
    south: number;
    east: number;
    north: number;
};
//# sourceMappingURL=geotiff.d.ts.map