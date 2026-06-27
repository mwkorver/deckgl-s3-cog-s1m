import { decompressWithDecompressionStream } from "./decompression-stream.js";
export async function decode(bytes) {
    return decompressWithDecompressionStream(bytes, { format: "deflate" });
}
//# sourceMappingURL=deflate.js.map