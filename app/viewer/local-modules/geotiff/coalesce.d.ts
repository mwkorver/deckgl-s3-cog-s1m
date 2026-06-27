import type { Source } from "@cogeotiff/core";
/** Range requests with a gap less than or equal to this default will be coalesced. */
export declare const COALESCE_DEFAULT: number;
/** No merged range will exceed this default size. */
export declare const MAX_RANGE_SIZE_DEFAULT: number;
/** Up to this number of merged-range requests are dispatched in parallel. */
export declare const COALESCE_PARALLEL = 6;
/** Options controlling how {@link coalesceRanges} merges and dispatches byte ranges. */
export interface CoalesceOptions {
    /** Max gap (bytes) between two ranges before they're merged. Default: 1 MiB. */
    coalesce?: number;
    /** Max size (bytes) of any merged range. Default: 16 MiB. */
    maxRangeSize?: number;
    /** Forwarded to `source.fetch`. */
    signal?: AbortSignal;
}
/** A byte range: `length` bytes starting at `offset`. */
export interface ByteRange {
    offset: number;
    length: number;
}
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
export declare function coalesceRanges(source: Pick<Source, "fetch">, ranges: ByteRange[], options?: CoalesceOptions): Promise<ArrayBuffer[]>;
//# sourceMappingURL=coalesce.d.ts.map