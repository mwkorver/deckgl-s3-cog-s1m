import { Compression, SampleFormat } from "@cogeotiff/core";
import { decode as decodeViaCanvas } from "./codecs/canvas.js";
import { decode as decodeDeflate } from "./codecs/deflate.js";
import { applyPredictor } from "./codecs/predictor.js";
async function decodeUncompressed(bytes) {
    return bytes;
}
/**
 * The global registry of decoders for each compression type.
 *
 * This maps a {@link Compression} value to a function that returns a promise of
 * a {@link Decoder}.
 */
export const DECODER_REGISTRY = new Map();
DECODER_REGISTRY.set(Compression.None, () => Promise.resolve(decodeUncompressed));
DECODER_REGISTRY.set(Compression.Deflate, () => Promise.resolve(decodeDeflate));
DECODER_REGISTRY.set(Compression.DeflateOther, () => Promise.resolve(decodeDeflate));
DECODER_REGISTRY.set(Compression.Lzw, () => import("./codecs/lzw.js").then((m) => m.decode));
DECODER_REGISTRY.set(Compression.Zstd, () => import("./codecs/zstd.js").then((m) => m.decode));
// DECODER_REGISTRY.set(Compression.Lzma, () =>
//   import("../codecs/lzma.js").then((m) => m.decode),
// );
// DECODER_REGISTRY.set(Compression.Jp2000, () =>
//   import("../codecs/jp2000.js").then((m) => m.decode),
// );
DECODER_REGISTRY.set(Compression.Jpeg, () => Promise.resolve(decodeViaCanvas));
DECODER_REGISTRY.set(Compression.Jpeg6, () => Promise.resolve(decodeViaCanvas));
DECODER_REGISTRY.set(Compression.Webp, () => Promise.resolve(decodeViaCanvas));
DECODER_REGISTRY.set(Compression.Lerc, () => import("./codecs/lerc.js").then((m) => m.decode));
/**
 * Decode a tile's bytes according to its compression and image metadata.
 */
export async function decode(bytes, compression, metadata) {
    const loader = DECODER_REGISTRY.get(compression);
    if (!loader) {
        throw new Error(`Unsupported compression: ${compression}`);
    }
    const decoder = await loader();
    const result = await decoder(bytes, metadata);
    if (result instanceof ArrayBuffer) {
        const { predictor, width, height, bitsPerSample, samplesPerPixel, planarConfiguration, } = metadata;
        const predicted = applyPredictor(result, predictor, width, height, bitsPerSample, samplesPerPixel, planarConfiguration);
        return {
            layout: "pixel-interleaved",
            data: toTypedArray(predicted, metadata),
        };
    }
    return result;
}
/**
 * Unpack a 1-bit packed mask buffer (MSB-first) into a Uint8Array of 0/255.
 * Each input byte holds 8 pixels; bit 7 is the first pixel in that byte.
 */
// TODO: check for FillOrder tag and reverse bit order if needed
// https://web.archive.org/web/20240329145342/https://www.awaresystems.be/imaging/tiff/tifftags/fillorder.html
export function unpackBitPacked(buffer, pixelCount) {
    const packed = new Uint8Array(buffer);
    const out = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        out[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0;
    }
    return out;
}
/**
 * Convert a raw ArrayBuffer of pixel data into a typed array based on the
 * sample format and bits per sample. This is used for codecs that return raw
 * bytes.
 */
function toTypedArray(buffer, metadata) {
    const { sampleFormat, bitsPerSample } = metadata;
    switch (sampleFormat) {
        case SampleFormat.Uint:
            switch (bitsPerSample) {
                case 1:
                    return unpackBitPacked(buffer, metadata.width * metadata.height * metadata.samplesPerPixel);
                case 8:
                    return new Uint8Array(buffer);
                case 16:
                    return new Uint16Array(buffer);
                case 32:
                    return new Uint32Array(buffer);
            }
            break;
        case SampleFormat.Int:
            switch (bitsPerSample) {
                case 8:
                    return new Int8Array(buffer);
                case 16:
                    return new Int16Array(buffer);
                case 32:
                    return new Int32Array(buffer);
            }
            break;
        case SampleFormat.Float:
            switch (bitsPerSample) {
                case 32:
                    return new Float32Array(buffer);
                case 64:
                    return new Float64Array(buffer);
            }
            break;
    }
    throw new Error(`Unsupported sample format/depth: SampleFormat=${sampleFormat}, BitsPerSample=${bitsPerSample}`);
}
//# sourceMappingURL=decode.js.map