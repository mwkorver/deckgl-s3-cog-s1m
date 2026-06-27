import { decompress } from "@developmentseed/lzw-tiff-decoder";
export async function decode(bytes, metadata) {
    const { width, height, samplesPerPixel, bitsPerSample } = metadata;
    const maxUncompressedSize = width * height * samplesPerPixel * (bitsPerSample / 8);
    const result = decompress(new Uint8Array(bytes), maxUncompressedSize);
    return copyIfViewNotFullBuffer(result);
}
// Duplicated in zstd.ts: sharing this via a separate module causes the bundler
// to emit a tiny shared chunk, adding a roundtrip on the codec's critical path.
function copyIfViewNotFullBuffer(view) {
    // If the view is already aligned, we can return its underlying buffer directly
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
        return view.buffer;
    }
    // Otherwise, we need to copy the relevant portion of the buffer into a new ArrayBuffer
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
}
//# sourceMappingURL=lzw.js.map