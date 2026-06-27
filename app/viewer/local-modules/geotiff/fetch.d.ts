import type { Source, TiffImage } from "@cogeotiff/core";
import { Compression } from "@cogeotiff/core";
import type { ProjJson } from "@s3-cog/proj";
import type { CachedTags } from "./ifd.js";
import type { DecoderPool } from "./pool/pool.js";
import type { Tile } from "./tile.js";
import type { HasTransform } from "./transform.js";
/** Protocol for objects that hold a TIFF reference and can request tiles. */
interface HasTiffReference extends HasTransform {
    readonly cachedTags: CachedTags;
    /** The data source used for fetching tile data. */
    readonly dataSource: Pick<Source, "fetch">;
    /** The data Image File Directory (IFD) */
    readonly image: TiffImage;
    /** The mask Image File Directory (IFD), if any. */
    readonly maskImage: TiffImage | null;
    /** The coordinate reference system. */
    readonly crs: number | ProjJson;
    /** The height of tiles in pixels. */
    readonly tileHeight: number;
    /** The width of tiles in pixels. */
    readonly tileWidth: number;
    /** The nodata value for the image, if any. */
    readonly nodata: number | null;
    /**
     * Internal: when true, the tile-fetch path logs each dataSource fetch to
     * the console. Set via `GeoTIFF.open({ debug: true })`.
     * @internal
     */
    readonly _debug?: boolean;
}
export declare function fetchTile(self: HasTiffReference, x: number, y: number, { boundless, pool, signal, }?: {
    boundless?: boolean;
    pool?: DecoderPool;
    signal?: AbortSignal;
}): Promise<Tile>;
/**
 * Fetch multiple tiles from a GeoTIFF or Overview, batching the underlying
 * reads.
 *
 * Unlike repeated {@link fetchTile} calls, this resolves every requested
 * tile's byte range up front and fetches the data through {@link getTiles} /
 * {@link getMultipleBytes}, which coalesce nearby ranges into far fewer HTTP
 * range requests — a big win when the coordinates form a contiguous block, as
 * they do when assembling a coarse tile from finer covering tiles. Decoding is
 * still done per tile (via the shared {@link assembleTile}); only the I/O is
 * batched.
 *
 * @param self - The GeoTIFF or Overview to fetch tiles from.
 * @param xy - Array of `[x, y]` tile coordinates.
 * @param options - Optional parameters (same as {@link fetchTile}).
 * @returns Array of {@link Tile} objects in the same order as `xy`.
 *
 * @see {@link fetchTile} for single-tile fetching.
 * @see {@link getTiles} for the batched, range-coalescing byte reader.
 */
export declare function fetchTiles(self: HasTiffReference, xy: Array<[number, number]>, { boundless, pool, signal, }?: {
    boundless?: boolean;
    pool?: DecoderPool;
    signal?: AbortSignal;
}): Promise<Tile[]>;
/**
 * Opt-in debug tag for {@link getTile} / {@link getBytes}. When present,
 * each underlying `dataSource.fetch` call is logged to the console with the
 * tag's `label`, the offset, and the byte count. When absent, no logging.
 */
type DebugTag = {
    label: string;
};
/**
 * Read image bytes for multiple ranges in a single batched I/O round trip.
 *
 * Vectorized counterpart to {@link getBytes}. The non-sparse ranges are
 * dispatched through {@link coalesceRanges}, which merges nearby byte ranges
 * into fewer `dataSource.fetch` calls. Returns one entry per input range, in
 * input order; sparse ranges (`offset === 0` or `byteCount === 0`) yield `null`,
 * matching {@link getBytes}.
 *
 * Vendored from cogeotiff PR #1463 (`TiffImage.getMultipleBytes`) for the same
 * reason as {@link getBytes}: tile data must read through the uncached
 * `dataSource` rather than the cached header source. Upstream also lets a
 * `Source` provide its own `fetchRanges`; `@cogeotiff/core@9.5.0` has no such
 * interface method and `dataSource` is only `Pick<Source, "fetch">`, so the
 * coalescing here is always done locally.
 */
export declare function getMultipleBytes(image: TiffImage, ranges: {
    offset: number;
    byteCount: number;
}[], dataSource: Pick<Source, "fetch">, options?: {
    signal?: AbortSignal;
    debug?: DebugTag;
    coalesce?: number;
    maxRangeSize?: number;
}): Promise<Array<{
    bytes: ArrayBuffer;
    compression: Compression;
} | null>>;
/**
 * Load multiple tiles in a single batched I/O round trip.
 *
 * Resolves the offset/size of every requested tile via `image.getTileSize`
 * (header-source reads — small entries, served by the chunk cache), then fetches
 * the tile data through {@link getMultipleBytes} (uncached `dataSource`, with
 * range coalescing). Returns one entry per input tile, in input order; sparse
 * tiles yield `null` matching {@link getBytes}.
 *
 * Vendored from cogeotiff PR #1463 (`TiffImage.getTiles`) for the same reason as
 * {@link getTile}: the tile-data read must route through `dataSource`.
 */
export declare function getTiles(image: TiffImage, xy: Array<[number, number]>, dataSource: Pick<Source, "fetch">, options?: {
    signal?: AbortSignal;
    debug?: DebugTag;
    coalesce?: number;
    maxRangeSize?: number;
}): Promise<Array<{
    bytes: ArrayBuffer;
    compression: Compression;
} | null>>;
export {};
//# sourceMappingURL=fetch.d.ts.map