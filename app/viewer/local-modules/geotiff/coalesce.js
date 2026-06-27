/** Range requests with a gap less than or equal to this default will be coalesced. */
export const COALESCE_DEFAULT = 1024 * 1024;
/** No merged range will exceed this default size. */
export const MAX_RANGE_SIZE_DEFAULT = 16 * 1024 * 1024;
/** Up to this number of merged-range requests are dispatched in parallel. */
export const COALESCE_PARALLEL = 6;
/**
 * Fetch the given byte ranges from a source, coalescing nearby ranges into a
 * smaller number of underlying `source.fetch` calls. Returns one `ArrayBuffer`
 * per input range, in input order.
 *
 * Vendored from cogeotiff PR #1463 (`packages/core/src/source.coalesce.ts`),
 * reformatted to this repo's conventions. Kept here (rather than relying on the
 * upstream `Source.fetchRanges` hook) because `@s3-cog/geotiff` routes
 * tile-data reads through an uncached `dataSource` typed as `Pick<Source, "fetch">`.
 */
export async function coalesceRanges(source, ranges, options) {
    if (ranges.length === 0) {
        return [];
    }
    const coalesce = options?.coalesce ?? COALESCE_DEFAULT;
    const maxRangeSize = options?.maxRangeSize ?? MAX_RANGE_SIZE_DEFAULT;
    const signal = options?.signal;
    const merged = mergeRanges(ranges, coalesce, maxRangeSize);
    const fetched = await dispatchMerged(source, merged, signal);
    const result = new Array(ranges.length);
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        const groupIndex = findGroupIndex(merged, range.offset);
        const group = merged[groupIndex];
        const groupBytes = fetched[groupIndex];
        const start = range.offset - group.offset;
        const end = start + range.length;
        if (end > groupBytes.byteLength) {
            throw new Error(`Failed to fetch bytes from offset:${range.offset} wanted:${range.length} got:${groupBytes.byteLength - start}`);
        }
        result[i] = groupBytes.slice(start, end);
    }
    return result;
}
/**
 * Sort ranges by offset and merge consecutive ones whose gap is `<= coalesce`
 * and whose merged size stays `<= maxRangeSize`.
 */
function mergeRanges(ranges, coalesce, maxRangeSize) {
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
    const out = [];
    let current = null;
    for (const r of sorted) {
        if (current == null) {
            current = { offset: r.offset, length: r.length };
            continue;
        }
        const currentEnd = current.offset + current.length;
        const nextEnd = r.offset + r.length;
        const gap = r.offset - currentEnd;
        const mergedEnd = Math.max(currentEnd, nextEnd);
        const mergedSize = mergedEnd - current.offset;
        if (gap <= coalesce && mergedSize <= maxRangeSize) {
            current.length = mergedEnd - current.offset;
        }
        else {
            out.push(current);
            current = { offset: r.offset, length: r.length };
        }
    }
    if (current != null) {
        out.push(current);
    }
    return out;
}
/** Binary search for the merged group whose offset is the largest `<= target`. */
function findGroupIndex(merged, target) {
    let lo = 0;
    let hi = merged.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (merged[mid].offset <= target) {
            lo = mid;
        }
        else {
            hi = mid - 1;
        }
    }
    return lo;
}
/** Fetch every merged range, at most {@link COALESCE_PARALLEL} requests in flight. */
async function dispatchMerged(source, merged, signal) {
    const out = new Array(merged.length);
    for (let i = 0; i < merged.length; i += COALESCE_PARALLEL) {
        const batch = merged.slice(i, i + COALESCE_PARALLEL);
        const results = await Promise.all(batch.map((g) => source.fetch(g.offset, g.length, { signal })));
        for (let j = 0; j < results.length; j++) {
            out[i + j] = results[j];
        }
    }
    return out;
}
//# sourceMappingURL=coalesce.js.map