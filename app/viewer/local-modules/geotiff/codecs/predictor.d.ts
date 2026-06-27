import { PlanarConfiguration, Predictor } from "@cogeotiff/core";
/**
 * Apply TIFF predictor decoding to a raw decoded tile buffer in-place.
 *
 * @param block              Decoded tile bytes.
 * @param predictor          Predictor enum value.
 * @param width              Tile width in pixels.
 * @param height             Tile height in pixels.
 * @param bitsPerSample      Bits per sample (all samples must be equal).
 * @param samplesPerPixel    Number of bands.
 * @param planarConfiguration  PlanarConfiguration enum value.
 */
export declare function applyPredictor(block: ArrayBuffer, predictor: Predictor, width: number, height: number, bitsPerSample: number, samplesPerPixel: number, planarConfiguration: PlanarConfiguration): ArrayBuffer;
//# sourceMappingURL=predictor.d.ts.map