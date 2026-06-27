import type { CompositeLayerProps, Layer, LayerContext, LayersList, UpdateParameters } from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import type { TileLayerProps } from "@deck.gl/geo-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import type { ConcurrencyLimiter, Priority } from "@s3-cog/geotiff";
import Flatbush from "flatbush";
import type { MosaicSource } from "./mosaic-tileset-2d.js";
export type MosaicLayerProps<MosaicT extends MosaicSource = MosaicSource, DataT = any> = CompositeLayerProps & Pick<TileLayerProps, "extent" | "maxCacheByteSize" | "maxCacheSize" | "maxRequests" | "maxZoom" | "minZoom"> & {
    /**
     * List of mosaic sources to render.
     *
     * The mosaic updates reactively when this prop is replaced with a new
     * array reference. Mutating the array in place will not trigger an
     * update — pass a fresh array (e.g. `[...sources, newItem]`) to add or
     * remove items.
     *
     * Tile cache reuse depends on stable tile IDs. By default, each source's
     * tile ID is derived from its position in this array (see
     * `MosaicSource.id`), so:
     *
     * - Appending items preserves all existing rendered tiles.
     * - Reordering or removing items from the middle of the array invalidates
     *   the cache slots of shifted items, causing them to re-fetch.
     *
     * Supply an explicit `id` per source if you need cache stability across
     * arbitrary mutations of `sources`.
     */
    sources: MosaicT[];
    /**
     * Optional revision token to force the layer to rebuild its spatial index
     * and refresh the cached tile indices.
     */
    revision?: number;
    /**
     * Caps concurrent HTTP requests for this layer's source fetches.
     *
     * Defaults to a maximum of 6 concurrent requests per origin, which aligns
     * with browser limits of 6 HTTP/1.1 requests per origin. If your sources
     * support HTTP/2 or HTTP/3, you may want to increase this limit or disable
     * it entirely by passing `null`.
     */
    concurrencyLimiter?: ConcurrencyLimiter | null;
    /** Fetch data for this source. */
    getSource?: (source: MosaicT, opts: {
        signal?: AbortSignal;
        /**
         * The layer's current `concurrencyLimiter` prop. Forward to
         * {@link GeoTIFF.fromUrl}'s `concurrencyLimiter` option so this
         * source's fetches join the shared per-origin queue.
         */
        concurrencyLimiter?: ConcurrencyLimiter | null;
        /**
         * Callback that provides dynamic priority for fetches related to this
         * source.
         *
         * This is designed to re-sort the limiter's queue on viewport pan,
         * preferring sources closer to the viewport center.
         */
        getPriority?: () => Priority;
    }) => Promise<DataT>;
    /** Render a source */
    renderSource: (source: MosaicT, opts: {
        data?: DataT;
        signal?: AbortSignal;
    }) => Layer | LayersList | null;
    /**
     * Called after a source's data has loaded successfully. `data` is the
     * value returned by `getSource`, or `undefined` when no `getSource` was
     * supplied.
     */
    onSourceLoad?: (source: MosaicT, info: {
        data?: DataT;
    }) => void;
    /**
     * Called when fetching a source's data fails.
     */
    onSourceError?: (source: MosaicT, info: {
        error: Error;
    }) => void;
    /**
     * Called when a source is evicted from the tile cache.
     */
    onSourceUnload?: (source: MosaicT, info: {
        data?: DataT;
    }) => void;
    /**
     * Called when all sources currently in the viewport have finished
     * loading.
     */
    onViewportLoad?: (entries: Array<{
        source: MosaicT;
        data?: DataT;
    }>) => void;
    /**
     * Optional min/max value range stretch for the fragment shader.
     */
    domain?: [number, number];
};
/**
 * A deck.gl layer for rendering a mosaic of raster sources.
 *
 * The `renderSource` prop is called whenever a source is present in the current
 * viewport.
 */
export declare class MosaicLayer<MosaicT extends MosaicSource = MosaicSource, DataT = any> extends CompositeLayer<MosaicLayerProps<MosaicT, DataT>> {
    static layerName: string;
    static defaultProps: Partial<MosaicLayerProps<MosaicSource, any>>;
    state: {
        index: Flatbush | null;
        /** Monotonically increasing counter bumped whenever `sources` changes.
         *  Passed as an `updateTrigger` to the inner TileLayer so deck.gl's
         *  prop-diffing detects the change and calls `updateState`, which in
         *  turn calls `_updateTileset` → `tileset.update`. */
        sourceRevision: number;
        ref?: {
            current: MosaicLayer<MosaicT, DataT>;
        };
        TilesetClass?: any;
    };
    initializeState(context: LayerContext): void;
    updateState(params: UpdateParameters<this>): void;
    private _buildSpatialIndex;
    renderTileLayer(renderSource: MosaicLayerProps<MosaicT, DataT>["renderSource"]): TileLayer;
    renderLayers(): Layer | null | LayersList;
}
//# sourceMappingURL=mosaic-layer.d.ts.map