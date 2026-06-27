import type { Compression } from "@cogeotiff/core";
import type { DecodedPixels, DecoderMetadata } from "../decode.js";
/** Message sent from main thread to worker. */
export type WorkerRequest = {
    jobId: number;
    compression: Compression;
    metadata: DecoderMetadata;
    buffer: ArrayBuffer;
};
/** Successful response from worker. */
export type WorkerResponse = {
    jobId: number;
    pixels: DecodedPixels;
    error?: never;
};
/** Error response from worker. */
export type WorkerErrorResponse = {
    jobId: number;
    error: string;
    pixels?: never;
};
/** Collect the transferable ArrayBuffers from a DecodedPixels. */
export declare function collectTransferables(pixels: DecodedPixels): Transferable[];
/**
 * Wraps a Worker, tracking in-flight jobs and routing responses via jobId.
 */
export declare class WorkerWrapper {
    readonly worker: Worker;
    private jobIdCounter;
    private jobs;
    constructor(worker: Worker);
    get jobCount(): number;
    private onMessage;
    submitJob(request: Omit<WorkerRequest, "jobId">, transferables: Transferable[]): Promise<DecodedPixels>;
    terminate(): void;
}
//# sourceMappingURL=wrapper.d.ts.map