import { PerOriginSemaphore } from "@s3-cog/geotiff";
/**
 * Shared default concurrency limiter for every COGLayer / MultiCOGLayer that
 * doesn't override its `concurrencyLimiter` prop. A single module-level
 * `PerOriginSemaphore({ maxRequests: 6 })` so two layers fetching from the
 * same origin (e.g. the same S3 bucket) share *one* HTTP/1.1 connection
 * pool. The cap matches Chrome's default per-origin HTTP/1.1 limit.
 */
export declare const DEFAULT_CONCURRENCY_LIMITER: PerOriginSemaphore;
//# sourceMappingURL=default-concurrency-limiter.d.ts.map