import type { LayerContext, UpdateParameters } from "@deck.gl/core";
import type { MinimalTileData, GetTileDataOptions as RasterTileGetTileDataOptions, RasterTileLayerProps, RasterTilesetDescriptor, RenderTileResult } from "@s3-cog/deck.gl-raster";
import { RasterTileLayer } from "@s3-cog/deck.gl-raster";
import type { ConcurrencyLimiter, DecoderPool, GeoTIFF, Overview } from "@s3-cog/geotiff";
import type { EpsgResolver, ProjectionDefinition } from "@s3-cog/proj";
import type { Texture } from "@luma.gl/core";
import type { TextureDataT } from "./geotiff/render-pipeline.js";
export type { MinimalTileData } from "@s3-cog/deck.gl-raster";
type DefaultDataT = MinimalTileData & {
    texture: Texture;
    byteLength: number;
};
/** Options passed to `getTileData`. */
export type GetTileDataOptions = RasterTileGetTileDataOptions & {
    /** The x coordinate of the tile within the IFD. */
    x: number;
    /** The y coordinate of the tile within the IFD. */
    y: number;
    /** The zoom level. */
    z: number;
    /** The decoder pool to use. */
    pool: DecoderPool;
};
type COGLayerDataProps<DataT extends MinimalTileData> = {
    /**
     * User-defined method to load data for a tile.
     *
     * Must be provided together with `renderTile`. If neither is provided,
     * the default pipeline is used, which fetches the tile, uploads it as a
     * GPU texture, and renders it using an inferred shader pipeline.
     */
    getTileData: (image: GeoTIFF | Overview, options: GetTileDataOptions) => Promise<DataT>;
    /**
     * User-defined method to render data for a tile.
     *
     * Must be provided together with `getTileData`. Receives the value
     * returned by `getTileData` and must return a render pipeline, or
     * `null` to skip rendering for this tile.
     */
    renderTile: (data: DataT) => RenderTileResult | null;
} | {
    getTileData?: undefined;
    renderTile?: undefined;
};
/**
 * Props that can be passed into the {@link COGLayer}.
 */
export type COGLayerProps<DataT extends MinimalTileData = DefaultDataT> = Omit<RasterTileLayerProps<DataT>, "tilesetDescriptor" | "getTileData" | "renderTile"> & COGLayerDataProps<DataT> & {
    /**
     * Cloud-optimized GeoTIFF input.
     *
     * - {@link URL} or `string` pointing to a COG
     * - {@link ArrayBuffer} containing the COG data
     * - An instance of the {@link GeoTIFF} class.
     */
    geotiff: GeoTIFF | string | URL | ArrayBuffer;
    /**
     * Optional source projection override.
     *
     * Use this when an external catalog already knows the correct CRS (for
     * example a STAC `proj:epsg` property) and you do not want to derive it
     * from the GeoTIFF metadata at runtime.
     */
    sourceProjection?: number | ProjectionDefinition;
    /**
     * A function callback for parsing numeric EPSG codes to projection
     * information (as returned by `wkt-parser`).
     *
     * The default implementation:
     * - makes a request to epsg.io to resolve EPSG codes found in the GeoTIFF.
     * - caches any previous requests
     * - parses PROJJSON response with `wkt-parser`
     */
    epsgResolver?: EpsgResolver;
    /**
     * Worker pool for decoding image chunks.
     *
     * If none is provided, a default Pool will be created and shared between all
     * COGLayer and GeoTIFFLayer instances.
     */
    pool?: DecoderPool;
    /**
     * Called when the GeoTIFF metadata has been loaded and parsed.
     */
    onGeoTIFFLoad?: (geotiff: GeoTIFF, options: {
        projection: ProjectionDefinition;
        /**
         * Bounds of the image in geographic coordinates (WGS84) [minLon, minLat,
         * maxLon, maxLat]
         */
        geographicBounds: {
            west: number;
            south: number;
            east: number;
            north: number;
        };
    }) => void;
    /** A user-provided AbortSignal to cancel loading.
     *
     * This can be useful in combination with the MosaicLayer, so that when a
     * mosaic source is out of the viewport, all of its tile requests are
     * automatically aborted.
     */
    signal?: AbortSignal;
    /**
     * Optional HTTP headers to send with every request for this GeoTIFF.
     *
     * Useful for authenticated sources, e.g. `{ Authorization: "Bearer …" }`
     * or `{ "x-amz-requester-pays": "requester" }` for requester-pays S3.
     *
     * Ignored when `geotiff` is a pre-opened `GeoTIFF` instance — wire the
     * headers via {@link GeoTIFF.fromUrl} at construction time instead.
     */
    headers?: Record<string, string>;
    /**
     * Caps concurrent HTTP requests for this layer's source fetches.
     *
     * Defaults to a maximum of 6 concurrent requests per origin, which aligns
     * with browser limits of 6 HTTP/1.1 requests per origin. If your sources
     * support HTTP/2 or HTTP/3, you may want to increase this limit or disable
     * it entirely by passing `null`.
     *
     * Ignored when `geotiff` is a pre-opened `GeoTIFF` instance — wire the
     * limiter via {@link GeoTIFF.fromUrl} at construction time instead.
     */
    concurrencyLimiter?: ConcurrencyLimiter | null;
    /**
     * Optional min/max value range stretch for the fragment shader.
     * Maps [min, max] in raw data units to [0, 1] for display.
     */
    domain?: [number, number];
};
/**
 * COGLayer renders a COG using a tiled approach with reprojection.
 */
export declare class COGLayer<DataT extends MinimalTileData = DefaultDataT> extends RasterTileLayer<DataT, COGLayerProps<DataT>> {
    static layerName: string;
    static defaultProps: typeof RasterTileLayer.defaultProps;
    state: {
        geotiff?: GeoTIFF;
        tilesetDescriptor?: RasterTilesetDescriptor;
        defaultGetTileData?: COGLayerProps<TextureDataT>["getTileData"];
        defaultRenderTile?: COGLayerProps<TextureDataT>["renderTile"];
        /** Aborts the in-flight header read when the `geotiff` prop changes or the
         *  layer is removed
         */
        abortController?: AbortController;
    };
    initializeState(): void;
    finalizeState(context: LayerContext): void;
    updateState(params: UpdateParameters<this>): void;
    clearState(): void;
    _parseGeoTIFF(): Promise<void>;
    protected _tilesetDescriptor(): RasterTilesetDescriptor | undefined;
    /**
     * Adapts the user-facing `(image, { x, y, ... }) => Promise<DataT>` signature
     * into RasterTileLayer's `(tile, { signal, device }) => Promise<DataT>`.
     */
    protected _getTileDataCallback(): ((tile: import("@deck.gl/geo-layers")._TileLoadProps, options: RasterTileGetTileDataOptions) => Promise<DataT>) | undefined;
    protected _renderTileCallback(): any;
}
//# sourceMappingURL=cog-layer.d.ts.map