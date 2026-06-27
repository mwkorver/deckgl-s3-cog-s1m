import type { PlanarConfiguration, Predictor } from "@cogeotiff/core";
import { Compression, SampleFormat } from "@cogeotiff/core";
import type { RasterTypedArray } from "./array.js";
/** Raster stored in one pixel-interleaved typed array. */
export type DecodedPixelInterleaved = {
    layout: "pixel-interleaved";
    /**
     * Pixel-interleaved raster data:
     * [p00_band0, p00_band1, ..., p01_band0, ...]
     *
     * Length = width * height * count.
     */
    data: RasterTypedArray;
};
/** Raster stored in one typed array per band (band-major / planar). */
export type DecodedBandSeparate = {
    layout: "band-separate";
    /**
     * One typed array per band, each length = width * height.
     *
     * This is the preferred representation when uploading one texture per band.
     */
    bands: RasterTypedArray[];
};
/** The result of a decoding process */
export type DecodedPixels = DecodedPixelInterleaved | DecodedBandSeparate;
/** Metadata from the TIFF IFD, passed to decoders that need it. */
export type DecoderMetadata = {
    sampleFormat: SampleFormat;
    bitsPerSample: number;
    samplesPerPixel: number;
    width: number;
    height: number;
    predictor: Predictor;
    planarConfiguration: PlanarConfiguration;
    lercParameters?: number[] | null;
};
/**
 * A decoder returns either:
 * - An ArrayBuffer of raw decompressed bytes (byte-level codecs like deflate, zstd)
 * - A DecodedPixels with typed pixel data (image codecs like LERC, JPEG)
 */
export type Decoder = (bytes: ArrayBuffer, metadata: DecoderMetadata) => Promise<ArrayBuffer | DecodedPixels>;
/**
 * The global registry of decoders for each compression type.
 *
 * This maps a {@link Compression} value to a function that returns a promise of
 * a {@link Decoder}.
 */
export declare const DECODER_REGISTRY: Map<Compression, () => Promise<Decoder>>;
/**
 * Decode a tile's bytes according to its compression and image metadata.
 */
export declare function decode(bytes: ArrayBuffer, compression: Compression, metadata: DecoderMetadata): Promise<DecodedPixels>;
/**
 * Unpack a 1-bit packed mask buffer (MSB-first) into a Uint8Array of 0/255.
 * Each input byte holds 8 pixels; bit 7 is the first pixel in that byte.
 */
export declare function unpackBitPacked(buffer: ArrayBuffer, pixelCount: number): Uint8Array;
//# sourceMappingURL=decode.d.ts.map