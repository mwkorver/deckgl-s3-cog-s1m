import type { CompositeLayerProps, DefaultProps, Layer } from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import type { _Tile2DHeader as Tile2DHeader, TileLayerProps, _TileLoadProps as TileLoadProps } from "@deck.gl/geo-layers";
import type { Device } from "@luma.gl/core";
import type { RenderTileResult } from "../raster-layer.js";
import type { RasterTilesetDescriptor } from "../raster-tileset/index.js";
/**
 * Minimum interface returned by `getTileData`.
 *
 * `null` is permitted to describe failed tile loads that do not produce any
 * data, which then do not render any layer.
 */
export type MinimalTileData = null | {
    /** Tile height in pixels. */
    height: number;
    /** Tile width in pixels. */
    width: number;
    /**
     * Byte length of the tile data, used by deck.gl's TileLayer for
     * byte-based cache eviction when `maxCacheByteSize` is set. Optional.
     */
    byteLength?: number;
};
/**
 * Options passed to a user-supplied `getTileData` callback.
 */
export type GetTileDataOptions = {
    /**
     * The luma.gl Device. Always populated by the base layer from
     * `this.context.device`.
     */
    device: Device;
    /**
     * Combined AbortSignal: the layer's `signal` prop composed with the
     * TileLayer's per-tile lifecycle signal. Fires when either aborts.
     */
    signal?: AbortSignal;
};
/**
 * Props for {@link RasterTileLayer}.
 */
export type RasterTileLayerProps<DataT extends MinimalTileData = MinimalTileData> = CompositeLayerProps & Pick<TileLayerProps, "debounceTime" | "extent" | "maxCacheByteSize" | "maxCacheSize" | "maxRequests" | "maxZoom" | "minZoom" | "onTileError" | "onTileLoad" | "onTileUnload" | "onViewportLoad" | "refinementStrategy" | "tileSize" | "zoomOffset"> & {
    /**
     * Tile pyramid + CRS projection descriptor.
     *
     * Subclasses may supply this via state by overriding the protected
     * `_tilesetDescriptor()` method.
     */
    tilesetDescriptor?: RasterTilesetDescriptor;
    /**
     * Load data for one tile. Runs once per (x, y, z); the resulting `DataT`
     * is cached by the underlying TileLayer.
     *
     * Subclasses may supply this via state by overriding
     * `_getTileDataCallback()`.
     */
    getTileData?: (tile: TileLoadProps, options: GetTileDataOptions) => Promise<DataT>;
    /**
     * Turn cached tile data into a render result (image and/or shader
     * pipeline). Called on every render; does not re-fetch.
     *
     * To invalidate the inner TileLayer's rendered sub-layers when a
     * dependency changes (e.g. a colormap choice), pass
     * `updateTriggers: { renderTile: [dep1, dep2] }` on the layer props.
     *
     * Subclasses may supply this via state by overriding `_renderTileCallback()`.
     */
    renderTile?: (data: DataT) => RenderTileResult | null;
    /**
     * Maximum reprojection error in pixels for mesh refinement.
     * Lower values create denser meshes.
     * @default 0.125
     */
    maxError?: number;
    /**
     * Show triangulation mesh + tile outlines.
     * @default false
     */
    debug?: boolean;
    /**
     * Opacity of the debug mesh overlay (0–1).
     * @default 0.5
     */
    debugOpacity?: number;
    /**
     * AbortSignal applied to every tile fetch, composed with TileLayer's
     * per-tile signal.
     */
    signal?: AbortSignal;
};
/**
 * Base-class prop shape that excludes the overridable fields.
 *
 * The three overridable fields (`tilesetDescriptor`, `getTileData`,
 * `renderTile`) are declared by `ExtraProps` instead — either via the generic
 * default (for direct use) or by a subclass that provides its own signatures
 * (e.g. `COGLayer`'s `getTileData(image, options)`).
 */
type RasterTileLayerBaseProps<DataT extends MinimalTileData> = Omit<RasterTileLayerProps<DataT>, "tilesetDescriptor" | "getTileData" | "renderTile">;
/**
 * Default `ExtraProps` for direct use of `RasterTileLayer`: brings the three
 * overridable fields back in with the generic signatures. Subclasses supply
 * their own `ExtraProps` to override these.
 */
type RasterTileLayerDefaultExtraProps<DataT extends MinimalTileData> = Pick<RasterTileLayerProps<DataT>, "tilesetDescriptor" | "getTileData" | "renderTile">;
/**
 * Base layer that renders a tiled raster source driven by a generic
 * {@link RasterTilesetDescriptor}.
 *
 * Usable directly (provide `tilesetDescriptor`, `getTileData`, and `renderTile`
 * as props) or as a base class (override the protected `_tilesetDescriptor`,
 * `_getTileDataCallback`, `_renderTileCallback` accessors to source them from
 * state).
 *
 * The generic `ExtraProps` parameter lets a subclass redeclare any of the
 * overridable fields with a domain-specific signature (e.g. `COGLayer`'s
 * `getTileData(image, options)`).
 */
export declare class RasterTileLayer<DataT extends MinimalTileData = MinimalTileData, ExtraProps extends object = RasterTileLayerDefaultExtraProps<DataT>> extends CompositeLayer<RasterTileLayerBaseProps<DataT> & ExtraProps> {
    static layerName: string;
    static defaultProps: DefaultProps<RasterTileLayerProps<MinimalTileData>>;
    /**
     * The currently effective {@link RasterTilesetDescriptor}.
     *
     * Subclasses override this to return a descriptor built from their own
     * async-parsed state. Returns `undefined` while the source is still
     * loading; `renderLayers()` returns `null` in that case.
     *
     * The inline cast to `RasterTileLayerProps<DataT>` is required because
     * `tilesetDescriptor` is declared on `ExtraProps`, not on the base's
     * `RasterTileLayerBaseProps`. For direct use the default `ExtraProps`
     * brings it in; for subclass use this method is overridden and the cast
     * is never reached.
     */
    protected _tilesetDescriptor(): RasterTilesetDescriptor | undefined;
    /**
     * The currently effective tile-fetch callback.
     *
     * Subclasses override this to adapt their user-facing `getTileData`
     * signature into the base's `(tile, options) => Promise<DataT>` shape.
     * Returns `undefined` when the callback is not yet available.
     */
    protected _getTileDataCallback(): RasterTileLayerProps<DataT>["getTileData"];
    /**
     * The currently effective per-tile render callback.
     *
     * Subclasses override this to thread their user-facing `renderTile` and
     * any inferred default. Returns `undefined` when no callback is available.
     */
    protected _renderTileCallback(): RasterTileLayerProps<DataT>["renderTile"];
    /**
     * Hook for rendering per-tile debug overlay sub-layers.
     *
     * Called once per tile from `_renderSubLayers` only when `props.debug` is
     * `true`. The hook fires both before data has arrived (`data` is `null`) and
     * after (`data` is the fetched `DataT`), so the default outline can render
     * during loading.
     *
     * Default behavior renders the primary tile boundary via
     * {@link renderDebugTileOutline} using the active descriptor. Subclasses can
     * override to replace, extend (via `super._renderDebug(...)`), or suppress
     * the default — for example, a multi-source layer can replace the default
     * with per-band tile outlines and tiered metadata labels once `data` is
     * available.
     */
    protected _renderDebug(tile: Tile2DHeader<DataT>, _data: DataT | null): Layer[];
    renderLayers(): Layer | null;
    private _renderTileLayer;
    private _wrapGetTileData;
    private _renderSubLayers;
}
export {};
//# sourceMappingURL=raster-tile-layer.d.ts.map