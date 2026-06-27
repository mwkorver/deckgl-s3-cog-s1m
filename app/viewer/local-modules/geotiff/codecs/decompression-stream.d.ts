export declare function assert(expression: unknown, msg?: string | undefined): asserts expression;
export declare function decompressWithDecompressionStream(data: ArrayBuffer | Response, { format, signal }: {
    format: CompressionFormat;
    signal?: AbortSignal;
}): Promise<ArrayBuffer>;
//# sourceMappingURL=decompression-stream.d.ts.map