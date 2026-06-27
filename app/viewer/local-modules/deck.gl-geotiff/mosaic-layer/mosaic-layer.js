import { _GlobeViewport, CompositeLayer, WebMercatorViewport, } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import Flatbush from "flatbush";
import { DEFAULT_CONCURRENCY_LIMITER } from "../default-concurrency-limiter.js";
import { MosaicTileset2D } from "./mosaic-tileset-2d.js";
const defaultProps = {
    concurrencyLimiter: DEFAULT_CONCURRENCY_LIMITER,
    sources: [],
};
/**
 * Build the limiter `getPriority` callback for one mosaic source: euclidean
 * distance from the source's bbox center to the current viewport center, in
 * lon/lat degree-space (just an ordering key — great-circle isn't needed).
 *
 * `getViewport` is read on every call, so the limiter re-sorts its queue as
 * the viewport pans, pulling newly-central sources ahead of edge sources.
 *
 * Returns `undefined` for non-geographic viewports — where the source bbox and
 * viewport center don't share a coordinate space — so the limiter falls back
 * to FIFO instead of comparing mismatched units. The viewport type is checked
 * once here; it isn't expected to change under the layer.
 */
function createGetPriorityCallback(bbox, getViewport) {
    const viewport = getViewport();
    if (!(viewport instanceof WebMercatorViewport) &&
        !(viewport instanceof _GlobeViewport)) {
        return undefined;
    }
    const [minX, minY, maxX, maxY] = bbox;
    const sourceCx = (minX + maxX) / 2;
    const sourceCy = (minY + maxY) / 2;
    return () => {
        // Geographic viewport (checked above); both types expose lon/lat.
        const v = getViewport();
        const dx = sourceCx - v.longitude;
        const dy = sourceCy - v.latitude;
        return Math.hypot(dx, dy);
    };
}
/**
 * A deck.gl layer for rendering a mosaic of raster sources.
 *
 * The `renderSource` prop is called whenever a source is present in the current
 * viewport.
 */
export class MosaicLayer extends CompositeLayer {
    static layerName = "MosaicLayer";
    static defaultProps = defaultProps;
    initializeState(context) {
        super.initializeState(context);
        this.setState({ sourceRevision: 0 });
        this._buildSpatialIndex();
    }
    updateState(params) {
        super.updateState(params);
        const { props, oldProps } = params;
        if (props.sources !== oldProps.sources || props.revision !== oldProps.revision) {
            this._buildSpatialIndex();
            this.setState({ sourceRevision: this.state.sourceRevision + 1 });
        }
    }
    _buildSpatialIndex() {
        const { sources } = this.props;
        if (sources.length === 0) {
            this.setState({ index: null });
            return;
        }
        const index = new Flatbush(sources.length);
        for (const source of sources) {
            index.add(...source.bbox);
        }
        index.finish();
        this.setState({ index });
    }
    renderTileLayer(renderSource) {
        const { id, concurrencyLimiter, extent, maxCacheByteSize, maxCacheSize, maxRequests, maxZoom, minZoom, onSourceLoad, onSourceError, onSourceUnload, onViewportLoad, } = this.props;
        if (!this.state.ref) {
            this.state.ref = { current: this };
        }
        else {
            this.state.ref.current = this;
        }
        if (!this.state.TilesetClass) {
            const ref = this.state.ref;
            const getSources = () => ref.current.props.sources;
            const getIndex = () => ref.current.state.index;
            const getRevision = () => ref.current.state.sourceRevision;
            class MosaicTileset2DFactory extends MosaicTileset2D {
                constructor(opts) {
                    super(getSources, getIndex, getRevision, opts);
                }
            }
            this.state.TilesetClass = MosaicTileset2DFactory;
        }
        return new TileLayer({
            id: `mosaic-layer-${id}`,
            TilesetClass: this.state.TilesetClass,
            ...omitUndefined({
                minZoom,
                maxZoom,
                extent,
                maxCacheByteSize,
                maxCacheSize,
                maxRequests,
            }),
            // Keyed to sourceRevision so the inner TileLayer detects a prop change
            // when sources are swapped. Using `renderSubLayers` (not `getTileData`)
            // avoids `reloadAll()` — existing cached tiles keep their data.
            // The MosaicTileset2D.update override handles the actual tile-index
            // re-evaluation; this trigger just ensures deck.gl calls updateState.
            updateTriggers: {
                renderSubLayers: [this.state.sourceRevision],
            },
            getTileData: async (data) => {
                // We hard-cast this because TilesetClass is not generic.
                // MosaicTileset2D returns MosaicT in `index`, but TileLayer's typing
                // exposes only the plain `TileIndex` here.
                const index = data.index;
                if (!index) {
                    return {
                        source: null,
                        data: undefined,
                        signal: data.signal,
                    };
                }
                const { signal } = data;
                const getPriority = index.bbox
                    ? createGetPriorityCallback(index.bbox, () => this.context.viewport)
                    : undefined;
                const userData = this.props.getSource &&
                    (await this.props.getSource(index, {
                        signal,
                        concurrencyLimiter,
                        getPriority,
                    }));
                return {
                    source: index,
                    data: userData,
                    signal,
                };
            },
            renderSubLayers: (props) => {
                const { data } = props;
                if (!data || !data.source) {
                    return null;
                }
                const { source, signal, data: userData } = data;
                const activeSignal = signal && !signal.aborted ? signal : undefined;
                return renderSource(source, { data: userData, signal: activeSignal });
            },
            ...(onSourceLoad && {
                onTileLoad: (tile) => {
                    if (!tile || !tile.index)
                        return;
                    // `tile.index` is a `ResolvedSource<MosaicT>` from
                    // MosaicTileset2D.getTileIndices, which structurally extends
                    // MosaicT.
                    const source = tile.index;
                    onSourceLoad(source, { data: tile.content?.data });
                },
            }),
            ...(onSourceError && {
                onTileError: (error, tile) => {
                    if (!tile || !tile.index) {
                        return;
                    }
                    const source = tile.index;
                    onSourceError(source, { error });
                },
            }),
            ...(onSourceUnload && {
                onTileUnload: (tile) => {
                    if (!tile || !tile.index)
                        return;
                    const source = tile.index;
                    onSourceUnload(source, { data: tile.content?.data });
                },
            }),
            ...(onViewportLoad && {
                onViewportLoad: (tiles) => {
                    onViewportLoad(tiles
                        .filter((tile) => tile && tile.index)
                        .map((tile) => ({
                        source: tile.index,
                        data: tile.content?.data,
                    })));
                },
            }),
        });
    }
    renderLayers() {
        const { sources, renderSource } = this.props;
        if (!sources) {
            return null;
        }
        // Note: we deliberately render the inner TileLayer even when `sources` is
        // empty so the same Tileset2D instance lives across empty -> non-empty
        // transitions and picks up later updates without recreation.
        return this.renderTileLayer(renderSource);
    }
}
/**
 * Drop keys whose value is `undefined`.
 *
 * Passing down an explicit `undefined` will override any default prop values.
 */
function omitUndefined(obj) {
    const result = {};
    for (const key in obj) {
        if (obj[key] !== undefined) {
            result[key] = obj[key];
        }
    }
    return result;
}
//# sourceMappingURL=mosaic-layer.js.map