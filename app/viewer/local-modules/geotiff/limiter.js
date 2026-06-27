/**
 * Normalize priority value: `undefined` or `NaN` becomes 0, so it sorts as un-prioritized.
 *
 * Coercing `NaN` matters because `NaN < x` and `NaN > x` both resolve to false,
 * so a `getPriority` that returns `NaN` (e.g. a distance from a degenerate
 * viewport) would otherwise compare as a tie with everything and silently
 * mis-sort, rather than falling back to FIFO.
 */
function normalizePriority(value) {
    return value === undefined || Number.isNaN(value) ? 0 : value;
}
/**
 * Compare two priorities. Returns negative if `a` should be serviced before
 * `b`, positive if `b` should go first, 0 on tie (queue then breaks the tie
 * by FIFO arrival order). Both shapes are normalised to arrays for compare.
 */
function comparePriorities(a, b) {
    const arrA = typeof a === "number" ? [a] : a;
    const arrB = typeof b === "number" ? [b] : b;
    const len = Math.max(arrA.length, arrB.length);
    for (let i = 0; i < len; i++) {
        const ai = normalizePriority(arrA[i]);
        const bi = normalizePriority(arrB[i]);
        if (ai < bi) {
            return -1;
        }
        if (ai > bi) {
            return 1;
        }
    }
    return 0;
}
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
export class Semaphore {
    active = 0;
    maxRequests;
    queue = [];
    constructor(options) {
        this.maxRequests = options.maxRequests;
    }
    acquire(signal, getPriority) {
        if (signal?.aborted) {
            return Promise.reject(signal.reason);
        }
        if (this.active < this.maxRequests) {
            this.active += 1;
            return Promise.resolve(this._makeRelease());
        }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, signal, getPriority };
            if (signal) {
                const onAbort = () => {
                    const idx = this.queue.indexOf(waiter);
                    if (idx >= 0) {
                        this.queue.splice(idx, 1);
                        reject(signal.reason);
                    }
                };
                waiter.onAbort = onAbort;
                signal.addEventListener("abort", onAbort, { once: true });
            }
            this.queue.push(waiter);
        });
    }
    /** Build a single-use release function for a freshly-granted slot.
     *  Calls beyond the first are no-ops, so double-releasing is safe. */
    _makeRelease() {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this._releaseOne();
        };
    }
    /** Hand off one slot: pick the lowest-priority waiter (re-evaluating each
     *  waiter's `getPriority` for dynamic ordering), grant it the slot — or, if
     *  the queue is empty, decrement {@link Semaphore.active} so the next
     *  `acquire` can take the freed slot directly. FIFO break on ties. */
    _releaseOne() {
        if (this.queue.length === 0) {
            this.active -= 1;
            return;
        }
        // Linear scan find-min. `bestIdx === 0` initially gives the earliest
        // arrival the implicit tiebreaker — only strictly-lower priorities can
        // bump it.
        let bestIdx = 0;
        let bestPrio = this.queue[0].getPriority?.() ?? 0;
        for (let i = 1; i < this.queue.length; i++) {
            const p = this.queue[i].getPriority?.() ?? 0;
            if (comparePriorities(p, bestPrio) < 0) {
                bestIdx = i;
                bestPrio = p;
            }
        }
        const next = this.queue.splice(bestIdx, 1)[0];
        if (next.signal && next.onAbort) {
            next.signal.removeEventListener("abort", next.onAbort);
        }
        // Hand the slot directly to the next waiter — `active` stays the same
        // because we're transferring ownership, not freeing and re-taking.
        next.resolve(this._makeRelease());
    }
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
export class PerOriginSemaphore {
    maxRequests;
    byOrigin = new Map();
    constructor(options) {
        this.maxRequests = options.maxRequests;
    }
    acquire(url, signal, getPriority) {
        const { origin } = url;
        let sem = this.byOrigin.get(origin);
        if (!sem) {
            sem = new Semaphore({ maxRequests: this.maxRequests });
            this.byOrigin.set(origin, sem);
        }
        return sem.acquire(signal, getPriority);
    }
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
export class LimitedSource {
    source;
    limiter;
    getPriority;
    constructor(source, opts) {
        this.source = source;
        this.limiter = opts.limiter;
        this.getPriority = opts.getPriority;
    }
    get type() {
        return this.source.type;
    }
    get url() {
        return this.source.url;
    }
    get metadata() {
        return this.source.metadata;
    }
    head(options) {
        return this.source.head(options);
    }
    async fetch(offset, length, options) {
        const release = await this.limiter.acquire(this.source.url, options?.signal, this.getPriority);
        try {
            return await this.source.fetch(offset, length, options);
        }
        finally {
            release();
        }
    }
}
//# sourceMappingURL=limiter.js.map