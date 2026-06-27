import type { Affine } from "@s3-cog/affine";
import type { ProjJson } from "@s3-cog/proj";
import type { DecodedBandSeparate, DecodedPixelInterleaved, DecodedPixels } from "./decode.js";
/** Typed arrays supported for raster sample storage. */
export type RasterTypedArray = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
/** Common metadata shared by all raster layouts. */
export type RasterArrayBase = {
    /** Number of bands (samples per pixel). */
    count: number;
    /** Height in pixels. */
    height: number;
    /** Width in pixels. */
    width: number;
    /**
     * Optional validity mask.  Length = height * width.
     * Non-zero = valid pixel, 0 = nodata (transparent).  null when no mask IFD is present.
     */
    mask: Uint8Array | null;
    /**
     * Affine geotransform [a, b, c, d, e, f] mapping pixel (col, row) to
     * geographic (x, y):
     *   x = a * col + b * row + c
     *   y = d * col + e * row + f
     */
    transform: Affine;
    /** Coordinate reference system information. */
    crs: number | ProjJson;
    /** Nodata value from `GDAL_NODATA` TIFF tag. */
    nodata: number | null;
};
/** Raster stored in one typed array per band (band-major / planar). */
export type RasterArrayBandSeparate = RasterArrayBase & DecodedBandSeparate;
/** Raster stored in one pixel-interleaved typed array. */
export type RasterArrayPixelInterleaved = RasterArrayBase & DecodedPixelInterleaved;
/** Decoded raster data from a GeoTIFF region. */
export type RasterArray = RasterArrayBase & DecodedPixels;
/** Options for packing band data to a 4-channel pixel-interleaved array. */
export type PackBandsToRGBAOptions = {
    /**
     * Source band index for each RGBA output channel.
     * Use null to write `fillValue` for that output channel.
     */
    order?: [number | null, number | null, number | null, number | null];
    /** Fill value used when an output channel has no source band. */
    fillValue?: number;
};
/** Convert any raster layout to a band-separate representation. */
export declare function toBandSeparate(array: RasterArray): RasterArrayBandSeparate;
/** Convert any raster layout to a pixel-interleaved representation. */
export declare function toPixelInterleaved(array: RasterArray, order?: readonly number[]): RasterArrayPixelInterleaved;
/** Reorder bands while keeping a band-separate representation. */
export declare function reorderBands(array: RasterArray, order: readonly number[]): RasterArrayBandSeparate;
/**
 * Pack selected source bands into an RGBA pixel-interleaved typed array.
 *
 * This is useful as a fallback path when a single 4-channel texture upload
 * is preferred over one texture per band.
 */
export declare function packBandsToRGBA(array: RasterArray, options?: PackBandsToRGBAOptions): RasterArrayPixelInterleaved;
//# sourceMappingURL=array.d.ts.map