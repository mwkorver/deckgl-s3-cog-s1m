import type { Compression } from "@cogeotiff/core";
import type { DecodedPixels, DecoderMetadata } from "../decode.js";
export type DecoderPoolOptions = {
    /**
     * Number of workers to create. Defaults to `navigator.hardwareConcurrency`
     * when available, otherwise 2. Set to 0 to disable workers and decode on
     * the main thread.
     */
    size?: number;
    /**
     * Factory that creates a Worker. When omitted, decoding runs on the main
     * thread regardless of `size`. Provide this to enable off-main-thread
     * decoding, e.g.:
     *
     * ```ts
     * {
     *   createWorker: () =>
     *     new Worker(new URL("./pool/worker.js", import.meta.url), { type: "module" }),
     * }
     * ```
     */
    createWorker?: () => Worker;
};
/**
 * Manages a pool of Web Workers for off-main-thread tile decoding.
 *
 * Use {@link defaultDecoderPool} to create a pool backed by the built-in,
 * default decompressors.
 *
 * When no `createWorker` factory is provided, decoding falls back to the main
 * thread. This lets the pool be constructed unconditionally and wired up with
 * a worker later (or never, for SSR / Node environments).
 */
export declare class DecoderPool {
    private readonly workerWrappers;
    constructor(options?: DecoderPoolOptions);
    /** True when workers are available for off-main-thread decoding. */
    get hasWorkers(): boolean;
    /**
     * Decode a compressed tile buffer.
     *
     * When workers are available, the compressed `bytes` buffer is transferred
     * zero-copy to the least-loaded worker. The returned `DecodedPixels` typed
     * array buffers are transferred back to the main thread.
     *
     * When no workers are available, decoding runs on the main thread via the
     * normal `decode()` path.
     */
    decode(bytes: ArrayBuffer, compression: Compression, metadata: DecoderMetadata): Promise<DecodedPixels>;
    /** Terminate all workers and release resources. */
    destroy(): void;
    private leastLoaded;
}
/**
 * Create a default `DecoderPool` backed by the built-in worker.
 *
 * A cached decoder pool instance is returned on subsequent calls.
 *
 * You may want to create it lazily (rather than as a module-level singleton)
 * to keep the `new URL(…, import.meta.url)` out of the module's static
 * initialisation, so bundlers that build IIFE/UMD outputs don't try to inline
 * the worker at build time.
 *
 * @example
 * Create a default decoder pool:
 * ```
 * const pool = defaultDecoderPool();
 * ```
 */
export declare function defaultDecoderPool(): DecoderPool;
//# sourceMappingURL=pool.d.ts.map