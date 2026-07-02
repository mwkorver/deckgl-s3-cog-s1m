import { SampleFormat } from "@cogeotiff/core";
import type { TextureFormat } from "@luma.gl/core";
/**
 * Infer the TextureFormat given values from GeoTIFF tags.
 */
export declare function inferTextureFormat(samplesPerPixel: number, bitsPerSample: Uint16Array, sampleFormat: SampleFormat[]): TextureFormat;
//# sourceMappingURL=texture.d.ts.map