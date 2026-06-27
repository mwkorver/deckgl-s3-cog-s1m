import type { Source, SourceMetadata } from "@chunkd/source";
/**
 * Numeric priority used to order waiters in a {@link Semaphore}'s queue. Lower
 * = serviced sooner. A single `number` is equivalent to a 1-tuple; arrays are
 * compared lexicographically (element-wise), with missing trailing elements
 * treated as 0. Returning `0` (or omitting `getPriority` entirely) makes the
 * waiter effectively un-prioritized — FIFO arrival order wins among ties.
 */
export type Priority = number | readonly number[];
/**
 * Counting semaphore with abort-aware acquire and dynamic priority. Internal
 * primitive used by {@link PerOriginSemaphore} and {@link LimitedSource}.
 *
 * Hands out up to `maxRequests` concurrent slots. Further `acquire()`s queue.
 * On every slot-open, the queue is searched for the lowest-priority waiter
 * (re-evaluating `getPriority` on each — so panning the viewport re-sorts the
 * queue if callers' priorities depend on viewport state). Ties break by FIFO
 * arrival order. A `Semaphore` with no priorities is therefore equivalent to
 * a plain FIFO queue.
 *
 * Acquires with an `AbortSignal` reject (and never consume a slot) if the
 * signal aborts before the slot is granted — either because it's already
 * aborted at call time, or because it aborts while queued.
 *
 * We use a single linear-scan find-min instead of a priority queue (heap)
 * because priorities are *dynamic* — we have to re-evaluate every waiter's
 * `getPriority` on each release anyway, which costs O(N). Linear scan + find-
 * min in the same pass also costs O(N), with a smaller constant and simpler
 * code; a heap would only win if we extracted multiple minima per release,
 * which we don't (one slot opens at a time).
 */
export declare class Semaphore {
    private active;
    private readonly maxRequests;
    private readonly queue;
    constructor(options: {
        maxRequests: number;
    });
    acquire(signal?: AbortSignal, getPriority?: () => Priority): Promise<() => void>;
    /** Build a single-use release function for a freshly-granted slot.
     *  Calls beyond the first are no-ops, so double-releasing is safe. */
    private _makeRelease;
    /** Hand off one slot: pick the lowest-priority waiter (re-evaluating each
     *  waiter's `getPriority` for dynamic ordering), grant it the slot — or, if
     *  the queue is empty, decrement {@link Semaphore.active} so the next
     *  `acquire` can take the freed slot directly. FIFO break on ties. */
    private _releaseOne;
}
/**
 * Minimal contract for capping concurrent {@link Source.fetch} calls. An
 * implementation hands out slots scoped however it likes; the default
 * {@link PerOriginSemaphore} scopes per `url.origin`.
 */
export interface ConcurrencyLimiter {
    /**
     * Acquire a slot to perform one fetch to `url`. Resolves to a release
     * function — call it exactly once when the fetch settles. If `signal`
     * aborts while waiting in the queue, the returned promise rejects with the
     * signal's reason and no slot is consumed.
     *
     * `getPriority` is an optional callback re-evaluated by the limiter on
     * every slot-open, so queued waiters can be re-ordered if their priority
     * depends on dynamic state (e.g. distance from viewport center, which
     * changes on pan). Lower-numeric = serviced sooner. A tuple sorts
     * lexicographically. Omitted = priority 0, FIFO among ties.
     */
    acquire(url: URL, signal?: AbortSignal, getPriority?: () => Priority): Promise<() => void>;
}
/**
 * Default {@link ConcurrencyLimiter}. Maintains a separate {@link Semaphore}
 * per `url.origin`, minted lazily on first encounter. Multiple consumers (e.g.
 * two `COGLayer`s on the same S3 bucket) targeting one origin share that
 * origin's slot pool; consumers targeting different origins don't compete.
 *
 * The browser's HTTP/1.1 per-origin connection cap (~6 on Chrome) is the
 * reason the cap is *per origin*, shared across layers — exceeding it just
 * makes the browser queue requests, blocking fresh ones behind stale ones.
 */
export declare class PerOriginSemaphore implements ConcurrencyLimiter {
    private readonly maxRequests;
    private readonly byOrigin;
    constructor(options: {
        maxRequests: number;
    });
    acquire(url: URL, signal?: AbortSignal, getPriority?: () => Priority): Promise<() => void>;
}
/** Options for {@link LimitedSource}. */
interface LimitedSourceOptions {
    /** The {@link ConcurrencyLimiter} to gate through. The wrapped source's
     *  own `url` is passed to `limiter.acquire` for per-origin routing. */
    limiter: ConcurrencyLimiter;
    /** Optional dynamic priority for every fetch through this source. The
     *  limiter re-invokes this callback on each slot-open, so closures over
     *  dynamic state (e.g. layer viewport center) re-sort the queue when that
     *  state changes. Lower = serviced sooner. */
    getPriority?: () => Priority;
}
/**
 * Wraps a {@link Source} so every `fetch` holds a {@link ConcurrencyLimiter}
 * slot for its duration — acquiring before the read, releasing when it settles
 * (resolve or reject). Forwards the read's `signal` to `limiter.acquire`, so a
 * request whose caller aborts while it is still queued for a slot is dropped
 * before any network I/O fires.
 *
 * Compose this *beneath* `SourceChunk` / `SourceCache` (i.e. as the
 * `SourceView`'s underlying source), so a cache hit short-circuits in
 * `SourceCache` and never reaches — never burns a slot on — the limiter:
 *
 * @example
 * ```ts
 * import { SourceView } from "@chunkd/source";
 * import { SourceCache, SourceChunk } from "@chunkd/middleware";
 *
 * const limited = new LimitedSource(source, { limiter });
 * const view = new SourceView(limited, [
 *   new SourceChunk({ size: 64 * 1024 }),
 *   new SourceCache({ size: 8 * 1024 * 1024 }),
 * ]);
 * ```
 *
 * **Why a source wrapper and not a chunkd `SourceMiddleware`** (which would
 * compose more naturally): chunkd's `SourceView` does not forward the request
 * `signal` to its middleware, so a middleware cannot observe an abort — only
 * the underlying source receives the read options (incl. `signal`) via
 * `SourceView`'s terminal handler. Wrapping the source is therefore the only
 * layer that can drop a queued request on abort. Revert to a `SourceMiddleware`
 * once chunkd forwards the signal (https://github.com/blacha/chunkd/pull/1697);
 * tracked in https://github.com/developmentseed/deck.gl-raster/issues/565.
 *
 * @internal
 */
export declare class LimitedSource implements Source {
    private readonly source;
    private readonly limiter;
    private readonly getPriority?;
    constructor(source: Source, opts: LimitedSourceOptions);
    get type(): string;
    get url(): URL;
    get metadata(): SourceMetadata | undefined;
    head(options?: {
        signal: AbortSignal;
    }): Promise<SourceMetadata>;
    fetch(offset: number, length?: number, options?: {
        signal: AbortSignal;
    }): Promise<ArrayBuffer>;
}
export {};
//# sourceMappingURL=limiter.d.ts.map