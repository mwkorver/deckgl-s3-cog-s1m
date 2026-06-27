export function assert(expression, msg = "") {
    if (!expression) {
        throw new Error(msg);
    }
}
export async function decompressWithDecompressionStream(data, { format, signal }) {
    const response = data instanceof Response ? data : new Response(data);
    assert(response.body, "Response does not contain body.");
    try {
        const decompressedResponse = new Response(response.body.pipeThrough(new DecompressionStream(format), { signal }));
        const buffer = await decompressedResponse.arrayBuffer();
        return buffer;
    }
    catch {
        signal?.throwIfAborted();
        throw new Error(`Failed to decode ${format}`);
    }
}
//# sourceMappingURL=decompression-stream.js.map