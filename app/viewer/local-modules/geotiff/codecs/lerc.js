import { Compression } from "@cogeotiff/core";
import { DECODER_REGISTRY } from "../decode.js";
/** Inner compression type encoded in LercParameters[1]. */
var LercCompression;
(function (LercCompression) {
    LercCompression[LercCompression["None"] = 0] = "None";
    LercCompression[LercCompression["Deflate"] = 1] = "Deflate";
    LercCompression[LercCompression["Zstd"] = 2] = "Zstd";
})(LercCompression || (LercCompression = {}));
let wasmInitialized = false;
async function getLerc() {
    // This import is cached by the module loader
    const lerc = await import("lerc");
    if (!wasmInitialized) {
        await lerc.load();
        wasmInitialized = true;
    }
    return lerc;
}
export async function decode(bytes, metadata) {
    const lercCompressionType = metadata.lercParameters?.[1] ??
        LercCompression.None;
    let lercInput = bytes;
    if (lercCompressionType === LercCompression.Deflate ||
        lercCompressionType === LercCompression.Zstd) {
        const innerCompression = lercCompressionType === LercCompression.Deflate
            ? Compression.Deflate
            : Compression.Zstd;
        const decoderEntry = DECODER_REGISTRY.get(innerCompression);
        const decoder = await decoderEntry();
        lercInput = (await decoder(bytes, metadata));
    }
    const lerc = await getLerc();
    const result = lerc.decode(lercInput);
    return { layout: "band-separate", bands: result.pixels };
}
//# sourceMappingURL=lerc.js.map