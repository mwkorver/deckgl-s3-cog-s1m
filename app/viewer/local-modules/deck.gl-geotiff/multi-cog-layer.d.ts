import type { CompositeLayerProps, Layer, LayerContext, UpdateParameters } from "@deck.gl/core";
import type { _Tile2DHeader as Tile2DHeader, TileLayerProps, _TileLoadProps as TileLoadProps } from "@deck.gl/geo-layers";
import type { Corners, GetTileDataOptions, MultiRasterTilesetDescriptor, ProjectionFunction, RasterModule, RasterTilesetDescriptor, RenderTileResult, UvTransform } from "@s3-cog/deck.gl-raster";
import { RasterTileLayer } from "@s3-cog/deck.gl-raster";
import type { ConcurrencyLimiter, DecoderPool, GeoTIFF } from "@s3-cog/geotiff";
import type { EpsgResolver } from "@s3-cog/proj";
import type { Texture } from "@luma.gl/core";
/** Data returned per band from tile fetching. */
interface BandTileData {
    /** GPU texture containing the band's raster data. */
    texture: Texture;
    /** UV transform for aligning this band's texture to the primary tile. */
    uvTransform: UvTransform;
    /** Width of the texture in pixels. */
    width: number;
    /** Height of the texture in pixels. */
    height: number;
    /** Byte length of the underlying texture data. */
    byteLength: number;
}
/** Debug metadata for a secondary band, collected during tile fetching. */
interface BandDebugInfo {
    /** CRS corners of each secondary tile fetched (for drawing outlines). */
    secondaryTileCorners: Corners[];
    /** Secondary zoom level index selected. */
    secondaryZ: number;
    /** UV transform applied to this band. */
    uvTransform: UvTransform;
    /** Stitched texture width in pixels. */
    stitchedWidth: number;
    /** Stitched texture height in pixels. */
    stitchedHeight: number;
    /** Number of secondary tiles fetched. */
    tileCount: number;
    /** Meters per pixel at the selected secondary level. */
    metersPerPixel: number;
}
/** Debug info for all bands of a single primary tile. */
interface MultiTileDebugInfo {
    /** Per-band debug metadata, keyed by source name. Only secondary bands. */
    bands: Map<string, BandDebugInfo>;
}
/** Result of {@link MultiCOGLayer._getTileData} -- all band textures plus reprojection functions. */
interface MultiTileResult {
    /** Per-band texture data, keyed by source name. */
    bands: Map<string, BandTileData>;
    /** Forward transform from pixel coordinates to CRS coordinates. */
    forwardTransform: ProjectionFunction;
    /** Inverse transform from CRS coordinates to pixel coordinates. */
    inverseTransform: ProjectionFunction;
    /** Width of the primary tile in pixels. */
    width: number;
    /** Height of the primary tile in pixels. */
    height: number;
    /** Byte length of all band textures, required for deck.gl TileLayer cache management. */
    byteLength: number;
    /** Only present when `debug: true`. */
    debugInfo?: MultiTileDebugInfo;
}
/**
 * Configuration for a single COG source within a {@link MultiCOGLayer}.
 */
export interface MultiCOGSourceConfig {
    /**
     * URL or ArrayBuffer of the COG.
     *
     * @see {@link fetchGeoTIFF} for supported input types.
     */
    url: string | URL | ArrayBuffer;
}
/** Internal state for a single opened COG source. */
interface SourceState {
    geotiff: GeoTIFF;
}
/**
 * Props accepted by {@link MultiCOGLayer}.
 *
 * Extends {@link CompositeLayerProps} with multi-source COG configuration and
 * optional tile-layer tuning knobs forwarded to the underlying
 * {@link TileLayerProps | TileLayer}.
 *
 * @see {@link MultiCOGLayer}
 * @see {@link MultiCOGSourceConfig}
 */
export type MultiCOGLayerProps = CompositeLayerProps & Pick<TileLayerProps, "debounceTime" | "maxCacheSize" | "maxCacheByteSize" | "maxRequests" | "refinementStrategy"> & {
    /**
     * Named sources -- each key becomes a band name used when compositing.
     *
     * @see {@link MultiCOGSourceConfig}
     */
    sources: Record<string, MultiCOGSourceConfig>;
    /**
     * Map source bands to RGB(A) output channels.
     *
     * @see {@link buildCompositeBandsProps}
     */
    composite?: {
        r: string;
        g?: string;
        b?: string;
        a?: string;
    };
    /**
     * Post-processing render pipeline modules applied after compositing.
     *
     * @see {@link RasterModule}
     */
    renderPipeline?: RasterModule[];
    /**
     * EPSG code resolver used to look up projection definitions for numeric
     * CRS codes found in GeoTIFF metadata.
     *
     * @default defaultEpsgResolver
     * @see {@link EpsgResolver}
     */
    epsgResolver?: EpsgResolver;
    /**
     * Decoder pool for parallel image chunk decompression.
     *
     * @see {@link DecoderPool}
     */
    pool?: DecoderPool;
    /**
     * Maximum reprojection error in pixels for mesh refinement.
     * Lower values create denser meshes with higher accuracy.
     *
     * @default 0.125
     */
    maxError?: number;
    /**
     * AbortSignal to cancel loading of all sources.
     */
    signal?: AbortSignal;
    /**
     * Called once all configured sources have been opened and the
     * {@link MultiRasterTilesetDescriptor} has been built.
     *
     * `geographicBounds` is computed from the primary (finest-resolution)
     * source and reprojected to WGS84; it matches the shape returned by
     * {@link COGLayerProps.onGeoTIFFLoad} and is suitable for passing to
     * MapLibre's `fitBounds`.
     */
    onGeoTIFFLoad?: (sources: Map<string, GeoTIFF>, options: {
        primaryKey: string;
        geographicBounds: {
            west: number;
            south: number;
            east: number;
            north: number;
        };
    }) => void;
    /**
     * Enable debug overlay showing tile boundaries and metadata labels
     * for all tilesets.
     *
     * @default false
     */
    debug?: boolean;
    /**
     * Opacity of the reprojection mesh debug overlay. Only used when
     * `debug` is `true`. Forwarded to the underlying {@link RasterLayer}.
     *
     * @default 0.5
     */
    debugOpacity?: number;
    /**
     * Controls how much detail is shown in debug text labels.
     *
     * - `1`: tile index and resolution only
     * - `2`: adds UV transform and tile count
     * - `3`: adds stitched dimensions and meters/pixel
     *
     * @default 1
     */
    debugLevel?: 1 | 2 | 3;
    /**
     * Caps concurrent HTTP requests for this layer's source fetches.
     *
     * Defaults to a maximum of 6 concurrent requests per origin, which aligns
     * with browser limits of 6 HTTP/1.1 requests per origin. If your sources
     * support HTTP/2 or HTTP/3, you may want to increase this limit or disable
     * it entirely by passing `null`.
     */
    concurrencyLimiter?: ConcurrencyLimiter | null;
};
/**
 * A deck.gl {@link CompositeLayer} that opens multiple Cloud-Optimized GeoTIFFs
 * (COGs) in parallel, builds a {@link RasterTilesetDescriptor} for each, and groups
 * them into a single {@link MultiRasterTilesetDescriptor}.
 *
 * The finest-resolution source is automatically selected as the primary
 * tileset, which drives the tile grid. Secondary sources are sampled at the
 * closest matching resolution.
 *
 * @see {@link MultiCOGLayerProps} for accepted props.
 * @see {@link createMultiRasterTilesetDescriptor} for the grouping logic.
 * @see {@link geoTiffToDescriptor} for the per-source tileset descriptor.
 */
export declare class MultiCOGLayer extends RasterTileLayer<MultiTileResult, MultiCOGLayerProps> {
    static layerName: string;
    static defaultProps: typeof RasterTileLayer.defaultProps;
    state: {
        sources: Map<string, SourceState> | null;
        multiDescriptor: MultiRasterTilesetDescriptor | null;
        /** Aborts the in-flight header reads when the layer is removed, freeing
         *  their limiter slots for fresh work. */
        abortController?: AbortController;
    };
    initializeState(): void;
    finalizeState(context: LayerContext): void;
    updateState({ changeFlags, props, oldProps, }: UpdateParameters<this>): void;
    /**
     * Open all configured COG sources in parallel, compute shared projection
     * functions, and build the {@link MultiRasterTilesetDescriptor}.
     *
     * All sources are assumed to share the same CRS; the projection of the
     * first source is used for the shared coordinate converters.
     *
     * @returns Resolves when all sources have been opened and state has been set.
     */
    _parseAllSources(): Promise<void>;
    /**
     * Fetch tile data for all configured sources at the given tile index.
     *
     * Primary-grid sources are fetched directly at (x, y, z). Secondary
     * sources are resolved to covering tiles at the closest matching zoom
     * level, fetched (potentially multiple tiles), stitched if necessary,
     * and returned with the appropriate UV transform.
     *
     * @param tile - Tile load props from the TileLayer, containing index and signal.
     * @returns Per-band textures, UV transforms, and reprojection functions.
     */
    _getTileData(tile: TileLoadProps, options: GetTileDataOptions): Promise<MultiTileResult>;
    protected _tilesetDescriptor(): RasterTilesetDescriptor | undefined;
    protected _getTileDataCallback(): ((tile: TileLoadProps, options: GetTileDataOptions) => Promise<MultiTileResult>) | undefined;
    protected _renderTileCallback(): ((data: MultiTileResult) => RenderTileResult | null) | undefined;
    protected _renderDebug(tile: Tile2DHeader<MultiTileResult>, data: MultiTileResult | null): Layer[];
    /**
     * Build the per-tile render pipeline. Mirrors the band-binding logic that
     * previously lived inline in `_renderSubLayers`.
     *
     * Returns `null` when the configured `composite` references a band that
     * isn't present in the cached tile data (happens transiently while sources
     * are switching).
     */
    private _buildRenderResult;
    /**
     * Fetch a single tile for a source that shares the primary tile grid.
     *
     * @returns A `[name, BandTileData, null]` tuple with identity UV transform
     *   and no debug info (primary bands don't need it).
     */
    private _fetchPrimaryBand;
    /**
     * Fetch covering tiles for a secondary source and stitch them into a
     * single texture using {@link assembleTiles}.
     *
     * @returns A `[name, BandTileData, BandDebugInfo | null]` tuple with the
     *   computed UV transform and optional debug metadata.
     */
    private _fetchSecondaryBand;
    /**
     * Render debug overlay layers for a single tile: colored outlines for
     * primary and secondary tile boundaries, and tiered text labels.
     *
     * @param tileId - Base id for sub-layer naming.
     * @param tile - The tile header with index info.
     * @param data - The fetched multi-tile result containing debug info.
     * @param forwardTo4326 - Projection function for converting CRS corners to WGS84.
     * @returns Array of PathLayer and TextLayer sub-layers.
     */
    private _renderDebugLayers;
}
export {};
//# sourceMappingURL=multi-cog-layer.d.ts.map