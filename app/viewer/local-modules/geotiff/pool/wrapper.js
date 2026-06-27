/** Collect the transferable ArrayBuffers from a DecodedPixels. */
export function collectTransferables(pixels) {
    if (pixels.layout === "pixel-interleaved") {
        return [pixels.data.buffer];
    }
    return pixels.bands.map((b) => b.buffer);
}
/**
 * Wraps a Worker, tracking in-flight jobs and routing responses via jobId.
 */
export class WorkerWrapper {
    worker;
    jobIdCounter = 0;
    jobs = new Map();
    constructor(worker) {
        this.worker = worker;
        this.worker.addEventListener("message", (e) => this.onMessage(e));
    }
    get jobCount() {
        return this.jobs.size;
    }
    onMessage(e) {
        const { jobId, error, pixels } = e.data;
        const job = this.jobs.get(jobId);
        this.jobs.delete(jobId);
        if (!job) {
            return;
        }
        if (error) {
            job.reject(new Error(error));
        }
        else {
            job.resolve(pixels);
        }
    }
    submitJob(request, transferables) {
        const jobId = this.jobIdCounter++;
        return new Promise((resolve, reject) => {
            this.jobs.set(jobId, { resolve, reject });
            this.worker.postMessage({ ...request, jobId }, { transfer: transferables });
        });
    }
    terminate() {
        this.worker.terminate();
    }
}
//# sourceMappingURL=wrapper.js.map