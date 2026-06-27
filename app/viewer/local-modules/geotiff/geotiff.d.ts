import type { Source, TiffImage, TiffImageTileCount } from "@cogeotiff/core";
import { Tiff } from "@cogeotiff/core";
import type { Affine } from "@s3-cog/affine";
import type { ProjJson } from "@s3-cog/proj";
import type { BandStatistics, GDALMetadata } from "./gdal-metadata.js";
import type { ChunkCachedSourceOptions } from "./chunk-cache.js";
import type { CachedTags, GeoKeyDirectory } from "./ifd.js";
import type { ConcurrencyLimiter, Priority } from "./limiter.js";
import { Overview } from "./overview.js";
import type { DecoderPool } from "./pool/pool.js";
import type { Tile } from "./tile.js";
/** Options for {@link GeoTIFF.fromUrl}. */
export interface GeoTIFFFromUrlOptions {
    /** Optional HTTP headers to send with every request for this GeoTIFF. */
    headers?: Record<string, string>;
    /** Bytes per chunk for the header cache. Defaults to 64 KiB (matches
     *  geotiff.js's BlockedSource). */
    chunkSize?: number;
    /** Total cache size in bytes. Defaults to 8 MiB (~128 blocks at the default
     *  chunk size). */
    cacheSize?: number;
    /** An optional {@link AbortSignal} to cancel the header reads. */
    signal?: AbortSignal;
    /** When true, the returned GeoTIFF logs each tile/mask data fetch to the
     *  console with offset/length and a `data`/`mask` label. Off by default. */
    debug?: boolean;
    /** Caps concurrent HTTP requests for both the header/metadata and tile-data
     *  paths. Header reads go through the cached `SourceView`, so cache hits
     *  short-circuit before the limiter and never consume a slot — only network
     *  reads gate. Pass `null` to explicitly disable; omit (or pass `undefined`)
     *  for the same effect — `GeoTIFF.fromUrl` does *not* default to a shared
     *  limiter on its own. The deck.gl-geotiff layers default to a shared
     *  {@link PerOriginSemaphore} via their `defaultProps`. */
    concurrencyLimiter?: ConcurrencyLimiter | null;
    /** Optional dynamic priority for every fetch through this GeoTIFF's sources.
     *  Re-invoked by the limiter on each slot-open, so closures over dynamic
     *  state (e.g. layer viewport center, tile bbox) re-sort the queue when that
     *  state changes. Lower = serviced sooner. Only meaningful when
     *  `concurrencyLimiter` is set. */
    getPriority?: () => Priority;
    /** Optional byte-range chunk cache for tile-data reads. Header/IFD reads keep
     *  using the normal small SourceChunk/SourceCache path. Use a stable
     *  cacheKey, such as s3://bucket/key, not a rotating signed URL. */
    chunkCache?: false | Omit<ChunkCachedSourceOptions, "cacheKey"> & {
        cacheKey: string;
    };
}
/**
 * A high-level GeoTIFF abstraction built on
 * {@link https://github.com/blacha/cogeotiff | @cogeotiff/core}'s `Tiff` and
 * `TiffImage` classes.
 *
 * This class separates data IFDs from mask IFDs, pairs them by resolution
 * level, and exposes sorted overviews. Intentionally mirrors the Python
 * {@link https://github.com/developmentseed/async-geotiff | async-geotiff} API
 * as closely as possible.
 *
 * Construct via {@link GeoTIFF.fromUrl}, {@link GeoTIFF.fromArrayBuffer},
 * {@link GeoTIFF.open} or {@link GeoTIFF.fromTiff}.
 *
 * @see {@link Overview} for reduced-resolution overview images.
 */
export declare class GeoTIFF {
    /**
     * Reduced-resolution overview levels, sorted finest-to-coarsest.
     *
     * Does not include the full-resolution image — use {@link fetchTile} on the
     * GeoTIFF instance itself for that.
     */
    readonly overviews: Overview[];
    /** A cached CRS value. */
    private _crs?;
    /** Cached TIFF tags that are pre-fetched when opening the GeoTIFF. */
    readonly cachedTags: CachedTags;
    /** The data source used for fetching tile data.
     *
     * This is typically the raw source (e.g. HTTP or memory) rather than a
     * layered source with caching and chunking, to avoid unnecessary copying of
     * tile data through cache layers.
     */
    readonly dataSource: Pick<Source, "fetch">;
    /** The underlying Tiff instance. */
    readonly tiff: Tiff;
    /** The primary (full-resolution) TiffImage. */
    readonly image: TiffImage;
    /** The mask IFD of the full-resolution GeoTIFF, if any. */
    readonly maskImage: TiffImage | null;
    /** The GeoKeyDirectory of the primary IFD. */
    readonly gkd: GeoKeyDirectory;
    /** Parsed GDALMetadata tag, if present. */
    readonly gdalMetadata: GDALMetadata | null;
    /**
     * Internal: when true, log each `dataSource` fetch (image tile data and
     * mask tile data) to the console with offset/length and a `data`/`mask`
     * label. Enable via the `debug` option on {@link GeoTIFF.open} or
     * {@link GeoTIFF.fromUrl}. Read by the tile-fetch path; not part of the
     * public API surface.
     *
     * @internal
     */
    readonly _debug: boolean;
    private constructor();
    /**
     * Open a GeoTIFF from a @cogeotiff/core Source.
     *
     * This creates and initialises the underlying Tiff, then classifies IFDs.
     *
     * @param options.dataSource A source for fetching tile data. This is separate from the source used to construct the TIFF to allow for separate caching implementations.
     * @param options.headerSource The source used to construct the TIFF. This is typically a layered source with caching and chunking, to optimise access to TIFF tags and IFDs. Callers who want to control the initial read size should compose a `SourceChunk` of the desired block size; cogeotiff's default `defaultReadSize` (16 KiB) gets padded up by the chunking layer anyway.
     * @param options.signal An optional {@link AbortSignal} to cancel the header reads.
     * @param options.debug When true, the returned GeoTIFF logs each tile/mask data fetch to the console. Off by default.
     */
    static open(options: {
        dataSource: Pick<Source, "fetch">;
        headerSource: Source;
        signal?: AbortSignal;
        debug?: boolean;
    }): Promise<GeoTIFF>;
    /**
     * Create a GeoTIFF from an already-initialised Tiff instance.
     *
     * All IFDs are walked; mask IFDs are matched to data IFDs by matching
     * (width, height).  Overviews are sorted from finest to coarsest resolution.
     *
     * @param dataSource A source for fetching tile data. This is separate from the source used to construct the TIFF to allow for separate caching implementations.
     * @param options.signal An optional {@link AbortSignal} to cancel header tag reads.
     * @param options.debug When true, the returned GeoTIFF logs each tile/mask data fetch to the console.
     */
    static fromTiff(tiff: Tiff, dataSource: Pick<Source, "fetch">, options?: {
        signal?: AbortSignal;
        debug?: boolean;
    }): Promise<GeoTIFF>;
    /**
     * Create a GeoTIFF from an ArrayBuffer containing the entire file.
     *
     * This is a convenience method that wraps the ArrayBuffer in a memory source
     * and calls {@link GeoTIFF.open}. For large files, consider using
     * {@link GeoTIFF.fromUrl} or {@link GeoTIFF.open} with a chunked HTTP source
     * to avoid loading the entire file into memory at once.
     *
     * @param input The ArrayBuffer containing the GeoTIFF file data.
     * @returns A Promise that resolves to a GeoTIFF instance.
     */
    static fromArrayBuffer(input: ArrayBuffer): Promise<GeoTIFF>;
    /**
     * Create a new GeoTIFF from a URL.
     *
     * Wraps the HTTP source with a fixed-size block-aligned LRU cache tuned for
     * TIFF metadata. cogeotiff's lazy per-entry reads (for tile offsets, byte
     * counts, and other tag values) are served by the block cache; adjacent
     * entries within a single block hit one underlying request. Tile data reads
     * bypass the cache and go straight to the raw HTTP source.
     *
     * @param url The URL of the GeoTIFF to open.
     * @param options Optional parameters; see {@link GeoTIFFFromUrlOptions}.
     * @returns A Promise that resolves to a GeoTIFF instance.
     */
    static fromUrl(url: string | URL, { headers, chunkSize, cacheSize, signal, debug, concurrencyLimiter, getPriority, chunkCache, }?: GeoTIFFFromUrlOptions): Promise<GeoTIFF>;
    /**
     * The CRS parsed from the GeoKeyDirectory.
     *
     * Returns an EPSG code (number) for EPSG-coded CRSes, or a PROJJSON object
     * for user-defined CRSes. The result is cached after the first access.
     *
     * See also {@link GeoTIFF.epsg} for the EPSG code directly from the TIFF tags.
     */
    get crs(): number | ProjJson;
    /** Image width in pixels. */
    get width(): number;
    /** Image height in pixels. */
    get height(): number;
    /** The number of tiles in the x and y directions */
    get tileCount(): TiffImageTileCount;
    /** Tile width in pixels. */
    get tileWidth(): number;
    /** Tile height in pixels. */
    get tileHeight(): number;
    /** The no data value, or null if not set. */
    get nodata(): number | null;
    /** Whether the primary image is tiled. */
    get isTiled(): boolean;
    /**
     * The pre-existing statistics for each band, if available.
     *
     * Extracted from the GDALMetadata TIFF tag; never computed on demand.
     * Keys are **1-based** band indices to match GDAL's convention.
     *
     * Returns `null` if no statistics are stored in the file.
     */
    get storedStats(): ReadonlyMap<number, BandStatistics> | null;
    /**
     * The offset for each band (0-indexed), defaulting to 0.
     *
     * Extracted from the GDALMetadata TIFF tag.
     */
    get offsets(): number[];
    /**
     * The scale for each band (0-indexed), defaulting to 1.
     *
     * Extracted from the GDALMetadata TIFF tag.
     */
    get scales(): number[];
    /** Number of bands (samples per pixel). */
    get count(): number;
    /** Bounding box [minX, minY, maxX, maxY] in the CRS. */
    get bbox(): [number, number, number, number];
    /**
     * Return the dataset's georeferencing transformation matrix.
     */
    get transform(): Affine;
    /** Fetch a single tile from the full-resolution image.
     *
     * @param x The tile column index (0-based).
     * @param y The tile row index (0-based).
     * @param options Optional parameters for fetching the tile.
     * @param options.boundless Whether to clip tiles that are partially outside the image bounds. When `true`, no clipping is applied and edge tiles are returned at the full nominal tile size. Defaults to `true`.
     * @param options.pool An optional {@link DecoderPool} for decoding the tile data. If not provided, a new decoder will be created for each tile.
     * @param options.signal An optional {@link AbortSignal} to cancel the fetch request.
     */
    fetchTile(x: number, y: number, options?: {
        boundless?: boolean;
        pool?: DecoderPool;
        signal?: AbortSignal;
    }): Promise<Tile>;
    /**
     * Fetch multiple tiles in parallel.
     *
     * A future implementation may coalesce contiguous byte ranges to reduce
     * the number of HTTP requests.
     *
     * @param xy - Array of `[x, y]` tile coordinates.
     * @param options - Optional parameters (same as {@link fetchTile}).
     * @returns Array of {@link Tile} objects in the same order as `xy`.
     *
     * @see {@link fetchTile} for single-tile fetching.
     */
    fetchTiles(xy: Array<[number, number]>, options?: {
        boundless?: boolean;
        pool?: DecoderPool;
        signal?: AbortSignal;
    }): Promise<Tile[]>;
    /**
     * Get the (row, col) pixel index containing the geographic coordinate (x, y).
     *
     * @param x          x coordinate in the CRS.
     * @param y          y coordinate in the CRS.
     * @param op         Rounding function applied to fractional pixel indices.
     *                   Defaults to Math.floor.
     * @returns          [row, col] pixel indices.
     */
    index(x: number, y: number, op?: (n: number) => number): [number, number];
    /**
     * Get the geographic (x, y) coordinate of the pixel at (row, col).
     *
     * @param row        Pixel row.
     * @param col        Pixel column.
     * @param offset     Which part of the pixel to return.  Defaults to "center".
     * @returns          [x, y] in the CRS.
     */
    xy(row: number, col: number, offset?: "center" | "ul" | "ur" | "ll" | "lr"): [number, number];
}
/**
 * Determine whether a TiffImage is a mask IFD.
 *
 * A mask IFD has SubFileType with the Mask bit set (value 4) AND
 * PhotometricInterpretation === Mask (4).
 */
export declare function isMaskIfd(image: TiffImage): boolean;
//# sourceMappingURL=geotiff.d.ts.map