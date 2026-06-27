/**
 * Default worker entry point for DecoderPool.
 *
 * In most cases you don't need to reference this file directly — call
 * `defaultDecoderPool()` instead, which creates a pool backed by this worker.
 *
 * To override codecs (e.g. swap in a WASM zstd decoder), create your own
 * worker file that mutates `registry` before importing this handler:
 *
 *   import { registry } from "@s3-cog/geotiff";
 *   import { Compression } from "@cogeotiff/core";
 *   registry.set(Compression.Zstd, () => import("./my-wasm-zstd.js").then(m => m.decode));
 *   import "@s3-cog/geotiff/pool/worker";
 *
 * Then pass a custom `createWorker` factory to `DecoderPool`:
 *
 *   new DecoderPool({
 *     createWorker: () =>
 *       new Worker(new URL("./my-worker.js", import.meta.url), { type: "module" }),
 *   });
 */
export {};
//# sourceMappingURL=worker.d.ts.map