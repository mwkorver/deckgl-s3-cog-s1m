import { Compression } from "@cogeotiff/core";
import type { DecodedPixels, DecoderMetadata } from "../decode.js";
import { DECODER_REGISTRY } from "../decode.js";

/** Inner compression type encoded in LercParameters[1]. */
enum LercCompression {
  None = 0,
  Deflate = 1,
  Zstd = 2,
}

let wasmInitialized = false;

async function getLerc() {
  // This import is cached by the module loader
  const lercModule = await import("lerc");
  const lerc = (lercModule as any).default || lercModule;

  if (!wasmInitialized) {
    if (typeof lerc.load === "function") {
      await lerc.load();
    }
    wasmInitialized = true;
  }

  return lerc;
}

export async function decode(
  bytes: ArrayBuffer,
  metadata: DecoderMetadata,
): Promise<DecodedPixels> {
  const lercCompressionType: LercCompression =
    (metadata.lercParameters?.[1] as LercCompression | undefined) ??
    LercCompression.None;

  let lercInput: ArrayBuffer = bytes;
  if (
    lercCompressionType === LercCompression.Deflate ||
    lercCompressionType === LercCompression.Zstd
  ) {
    const innerCompression =
      lercCompressionType === LercCompression.Deflate
        ? Compression.Deflate
        : Compression.Zstd;
    const decoderEntry = DECODER_REGISTRY.get(innerCompression)!;
    const decoder = await decoderEntry();
    lercInput = (await decoder(bytes, metadata)) as ArrayBuffer;
  }

  const lerc = await getLerc();
  const result = lerc.decode(lercInput);
  // lerc returns `pixels` as one typed array per LERC band, each holding
  // `dimCount` interleaved values per pixel. GDAL encodes TIFF LERC tiles two
  // ways: planar (PlanarConfig=2) -> one band per sample, dimCount=1, which maps
  // to band-separate; chunky (PlanarConfig=1) -> a single band whose dimCount
  // equals samplesPerPixel, i.e. the samples are already pixel-interleaved.
  const { pixels, dimCount } = result;
  if (dimCount === 1) {
    return { layout: "band-separate", bands: pixels };
  }
  if (pixels.length === 1) {
    return { layout: "pixel-interleaved", data: pixels[0] };
  }
  throw new Error(
    `Unsupported LERC layout: bandCount=${pixels.length}, dimCount=${dimCount}`,
  );
}
