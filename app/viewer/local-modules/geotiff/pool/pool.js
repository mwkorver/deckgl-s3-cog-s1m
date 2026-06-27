import { decode } from "../decode.js";
import { WorkerWrapper } from "./wrapper.js";
const defaultSize = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 2) : 2;
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
export class DecoderPool {
    workerWrappers;
    constructor(options = {}) {
        const { size = defaultSize, createWorker } = options;
        this.workerWrappers = [];
        if (createWorker && size > 0) {
            for (let i = 0; i < size; i++) {
                this.workerWrappers.push(new WorkerWrapper(createWorker()));
            }
        }
    }
    /** True when workers are available for off-main-thread decoding. */
    get hasWorkers() {
        return this.workerWrappers.length > 0;
    }
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
    async decode(bytes, compression, metadata) {
        if (!this.hasWorkers) {
            return decode(bytes, compression, metadata);
        }
        const worker = this.leastLoaded();
        const request = {
            compression: compression,
            metadata,
            buffer: bytes,
        };
        const array = await worker.submitJob(request, [bytes]);
        return array;
    }
    /** Terminate all workers and release resources. */
    destroy() {
        for (const w of this.workerWrappers) {
            w.terminate();
        }
        this.workerWrappers.length = 0;
    }
    leastLoaded() {
        let best = this.workerWrappers[0];
        for (let i = 1; i < this.workerWrappers.length; i++) {
            if (this.workerWrappers[i].jobCount < best.jobCount) {
                best = this.workerWrappers[i];
            }
        }
        return best;
    }
}
/**
 * A default DecoderPool instance.
 *
 * It will be created on first call of `defaultDecoderPool`.
 */
let DEFAULT_POOL = null;
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
export function defaultDecoderPool() {
    if (DEFAULT_POOL !== null) {
        return DEFAULT_POOL;
    }
    DEFAULT_POOL = new DecoderPool({
        createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
    });
    return DEFAULT_POOL;
}
//# sourceMappingURL=pool.js.map