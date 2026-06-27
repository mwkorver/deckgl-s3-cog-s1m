import { CompositeLayer } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { renderDebugTileOutline } from "../layer-utils.js";
import { RasterLayer } from "../raster-layer.js";
import { RasterTileset2D } from "../raster-tileset/index.js";
const defaultProps = {
    ...TileLayer.defaultProps,
    maxError: 0.125,
    debug: false,
    debugOpacity: 0.5,
};
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
export class RasterTileLayer extends CompositeLayer {
    static layerName = "RasterTileLayer";
    static defaultProps = defaultProps;
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
    _tilesetDescriptor() {
        return this.props
            .tilesetDescriptor;
    }
    /**
     * The currently effective tile-fetch callback.
     *
     * Subclasses override this to adapt their user-facing `getTileData`
     * signature into the base's `(tile, options) => Promise<DataT>` shape.
     * Returns `undefined` when the callback is not yet available.
     */
    _getTileDataCallback() {
        return this.props.getTileData;
    }
    /**
     * The currently effective per-tile render callback.
     *
     * Subclasses override this to thread their user-facing `renderTile` and
     * any inferred default. Returns `undefined` when no callback is available.
     */
    _renderTileCallback() {
        return this.props.renderTile;
    }
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
    _renderDebug(tile, _data) {
        const descriptor = this._tilesetDescriptor();
        if (!descriptor) {
            return [];
        }
        // Tiles built by RasterTileset2D are augmented with RasterTileMetadata
        // (projectedBbox/Corners, tileWidth/Height) at construction time. The cast
        // makes that runtime augmentation visible to the typed helper.
        return renderDebugTileOutline(`${this.id}-${tile.id}-bounds`, tile, descriptor.projectTo4326);
    }
    renderLayers() {
        const descriptor = this._tilesetDescriptor();
        const getTileData = this._getTileDataCallback();
        const renderTile = this._renderTileCallback();
        if (!descriptor || !getTileData || !renderTile) {
            return null;
        }
        return this._renderTileLayer(descriptor, getTileData, renderTile);
    }
    _renderTileLayer(descriptor, getTileData, renderTile) {
        if (!this.state.TilesetClass || this.state.descriptor !== descriptor) {
            const device = this.context.device;
            class TilesetFactory extends RasterTileset2D {
                constructor(opts) {
                    super(opts, descriptor, {
                        getPixelRatio: () => {
                            const ctx = device.getDefaultCanvasContext();
                            const [drawingBufferWidth] = ctx.getDrawingBufferSize();
                            const [cssWidth] = ctx.getCSSSize();
                            return cssWidth ? drawingBufferWidth / cssWidth : 1;
                        },
                    });
                }
            }
            this.state.TilesetClass = TilesetFactory;
            this.state.descriptor = descriptor;
        }
        const { tileSize, zoomOffset, maxZoom, minZoom, extent, debounceTime, maxCacheSize, maxCacheByteSize, maxRequests, refinementStrategy, updateTriggers, onTileError, onTileLoad, onTileUnload, onViewportLoad, } = this.props;
        return new TileLayer({
            id: `raster-tile-layer-${this.id}`,
            TilesetClass: this.state.TilesetClass,
            getTileData: (tile) => this._wrapGetTileData(tile, getTileData),
            renderSubLayers: (props) => this._renderSubLayers(props, descriptor, renderTile),
            updateTriggers: {
                renderSubLayers: [
                    ...(Array.isArray(updateTriggers?.renderTile)
                        ? updateTriggers.renderTile
                        : updateTriggers?.renderTile !== undefined
                            ? [updateTriggers.renderTile]
                            : []),
                    this.props.domain,
                ],
                getTileData: updateTriggers?.getTileData,
            },
            tileSize,
            zoomOffset,
            maxZoom,
            minZoom,
            extent,
            debounceTime,
            maxCacheSize,
            maxCacheByteSize,
            maxRequests,
            refinementStrategy,
            onTileError,
            onTileLoad,
            onTileUnload,
            onViewportLoad,
        });
    }
    async _wrapGetTileData(tile, getTileData) {
        const { signal: tileSignal } = tile;
        const userSignal = this.props.signal;
        const signal = userSignal && tileSignal
            ? AbortSignal.any([userSignal, tileSignal])
            : (userSignal ?? tileSignal);
        const options = {
            device: this.context.device,
            signal,
        };
        return getTileData(tile, options);
    }
    _renderSubLayers(props, descriptor, renderTile) {
        const { maxError, debug, debugOpacity } = this.props;
        const tile = props.tile;
        const debugLayers = debug
            ? this._renderDebug(tile, props.data ?? null)
            : [];
        if (!props.data) {
            return debugLayers;
        }
        // Access forwardTransform/inverseTransform from tile metadata so that
        // reference equality holds across renders.
        const { forwardTransform, inverseTransform } = tile;
        const tileResult = renderTile(props.data);
        if (!tileResult) {
            return debugLayers;
        }
        const { image, renderPipeline } = tileResult;
        const { width, height } = props.data;
        const isGlobe = this.context.viewport.resolution !== undefined;
        let reprojectionFns;
        let coordinateSystem;
        if (isGlobe) {
            // Globe view
            reprojectionFns = {
                forwardTransform,
                inverseTransform,
                forwardReproject: descriptor.projectTo4326,
                inverseReproject: descriptor.projectFrom4326,
            };
            coordinateSystem = "lnglat";
        }
        else {
            // Web Mercator: render the mesh directly in deck.gl common space.
            //
            // The tile's `_projectPosition` maps source CRS → common space, support
            // high precision with fp64 emulation.
            //
            // `_projectPosition`/`_unprojectPosition` must be reference-stable across
            // renders to avoid regenerating the mesh and recompiling the shader every
            // frame.
            const { _projectPosition, _unprojectPosition } = tile;
            reprojectionFns = {
                forwardTransform,
                inverseTransform,
                forwardReproject: _projectPosition,
                inverseReproject: _unprojectPosition,
            };
            coordinateSystem = "cartesian";
        }
        const rasterLayer = new RasterLayer(this.getSubLayerProps({
            id: `${props.id}-raster`,
            width,
            height,
            // Passing `image: undefined` explicitly would trip isAsyncPropLoading
            // and cause a transient black flash (see issue #376).
            ...(image !== undefined && { image }),
            renderPipeline,
            maxError,
            reprojectionFns,
            debug,
            debugOpacity,
            coordinateSystem,
        }));
        return [rasterLayer, ...debugLayers];
    }
}
//# sourceMappingURL=raster-tile-layer.js.map