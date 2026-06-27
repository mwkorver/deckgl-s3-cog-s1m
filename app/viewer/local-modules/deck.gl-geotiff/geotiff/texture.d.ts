import { SampleFormat } from "@cogeotiff/core";
import type { GeoTIFF } from "@s3-cog/geotiff";
import type { TextureFormat, TextureProps, TypedArray } from "@luma.gl/core";
/**
 * Infers texture properties from a GeoTIFF image and its associated data.
 */
export declare function createTextureProps(geotiff: GeoTIFF, data: TypedArray, options: {
    width: number;
    height: number;
}): TextureProps;
/**
 * Infer the TextureFormat given values from GeoTIFF tags.
 */
export declare function inferTextureFormat(samplesPerPixel: number, bitsPerSample: Uint16Array, sampleFormat: SampleFormat[]): TextureFormat;
//# sourceMappingURL=texture.d.ts.map