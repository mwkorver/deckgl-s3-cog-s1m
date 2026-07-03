import type {
  CompositeLayerProps,
  Layer,
  LayerContext,
  LayersList,
  UpdateParameters,
  Viewport,
} from "@deck.gl/core";
import {
  _GlobeViewport,
  CompositeLayer,
  WebMercatorViewport,
} from "@deck.gl/core";
import type { TileLayerProps } from "@deck.gl/geo-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import type { ConcurrencyLimiter, Priority } from "@s3-cog/geotiff";
import Flatbush from "flatbush";
import { DEFAULT_CONCURRENCY_LIMITER } from "../default-concurrency-limiter.js";
import type { MosaicSource } from "./mosaic-tileset-2d.js";
import { MosaicTileset2D } from "./mosaic-tileset-2d.js";

export type MosaicLayerProps<
  MosaicT extends MosaicSource = MosaicSource,
  DataT = any,
> = CompositeLayerProps &
  Pick<
    TileLayerProps,
    // NOTE: `debounceTime` is intentionally not exposed.
    // See https://github.com/developmentseed/deck.gl-raster/issues/562
    | "extent"
    | "maxCacheByteSize"
    | "maxCacheSize"
    | "maxRequests"
    | "maxZoom"
    | "minZoom"
  > & {
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
    getSource?: (
      source: MosaicT,
      opts: {
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
      },
    ) => Promise<DataT>;

    /** Render a source */
    renderSource: (
      source: MosaicT,
      opts: {
        data?: DataT;
        signal?: AbortSignal;
      },
    ) => Layer | LayersList | null;

    /**
     * Called after a source's data has loaded successfully. `data` is the
     * value returned by `getSource`, or `undefined` when no `getSource` was
     * supplied.
     */
    onSourceLoad?: (source: MosaicT, info: { data?: DataT }) => void;

    /**
     * Called when fetching a source's data fails.
     */
    onSourceError?: (source: MosaicT, info: { error: Error }) => void;

    /**
     * Called when a source is evicted from the tile cache.
     */
    onSourceUnload?: (source: MosaicT, info: { data?: DataT }) => void;

    /**
     * Called when all sources currently in the viewport have finished
     * loading.
     */
    onViewportLoad?: (
      entries: Array<{ source: MosaicT; data?: DataT }>,
    ) => void;

    /**
     * Optional min/max value range stretch for the fragment shader.
     */
    domain?: [number, number];
  };

const defaultProps: Partial<MosaicLayerProps> = {
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
function createGetPriorityCallback(
  bbox: readonly [number, number, number, number],
  getViewport: () => Viewport,
): (() => number) | undefined {
  const viewport = getViewport();
  if (
    !(viewport instanceof WebMercatorViewport) &&
    !(viewport instanceof _GlobeViewport)
  ) {
    return undefined;
  }

  const [minX, minY, maxX, maxY] = bbox;
  const sourceCx = (minX + maxX) / 2;
  const sourceCy = (minY + maxY) / 2;

  return (): number => {
    // Geographic viewport (checked above); both types expose lon/lat.
    const v = getViewport() as WebMercatorViewport | _GlobeViewport;
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
export class MosaicLayer<
  MosaicT extends MosaicSource = MosaicSource,
  DataT = any,
> extends CompositeLayer<MosaicLayerProps<MosaicT, DataT>> {
  static override layerName = "MosaicLayer";
  static override defaultProps = defaultProps;

  declare state: {
    // The index can be null if sources are empty
    index: Flatbush | null;
    /** Monotonically increasing counter bumped whenever `sources` changes.
     *  Passed as an `updateTrigger` to the inner TileLayer so deck.gl's
     *  prop-diffing detects the change and calls `updateState`, which in
     *  turn calls `_updateTileset` → `tileset.update`. */
    sourceRevision: number;
    ref?: { current: MosaicLayer<MosaicT, DataT> };
    TilesetClass?: any;
  };

  override initializeState(context: LayerContext): void {
    super.initializeState(context);
    this.setState({ sourceRevision: 0 });
    this._buildSpatialIndex();
  }

  override updateState(params: UpdateParameters<this>): void {
    super.updateState(params);

    const { props, oldProps } = params;

    if (
      props.sources !== oldProps.sources ||
      props.revision !== oldProps.revision
    ) {
      this._buildSpatialIndex();
      this.setState({ sourceRevision: this.state.sourceRevision + 1 });
    }
  }

  private _buildSpatialIndex(): void {
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

  renderTileLayer(
    renderSource: MosaicLayerProps<MosaicT, DataT>["renderSource"],
  ): TileLayer {
    const {
      id,
      concurrencyLimiter,
      extent,
      maxCacheByteSize,
      maxCacheSize,
      maxRequests,
      maxZoom,
      minZoom,
      onSourceLoad,
      onSourceError,
      onSourceUnload,
      onViewportLoad,
    } = this.props;

    if (!this.state.ref) {
      this.state.ref = { current: this };
    } else {
      this.state.ref.current = this;
    }

    if (!this.state.TilesetClass) {
      const ref = this.state.ref;
      const getSources = () => ref.current.props.sources;
      const getIndex = () => ref.current.state.index;
      const getRevision = () => ref.current.state.sourceRevision;
      class MosaicTileset2DFactory extends MosaicTileset2D<MosaicT> {
        constructor(opts: any) {
          super(getSources, getIndex, getRevision, opts);
        }
      }
      this.state.TilesetClass = MosaicTileset2DFactory;
    }

    return new TileLayer<{
      source: MosaicT;
      data?: DataT;
      signal?: AbortSignal;
    }>({
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
        const index = data.index as unknown as MosaicT;
        if (!index) {
          return {
            source: null as any,
            data: undefined,
            signal: data.signal,
          };
        }
        const { signal } = data;
        const getPriority = index.bbox
          ? createGetPriorityCallback(index.bbox, () => this.context.viewport)
          : undefined;
        const userData =
          this.props.getSource &&
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
        if (!data?.source) {
          return null;
        }
        const { source, signal, data: userData } = data;
        const activeSignal = signal && !signal.aborted ? signal : undefined;
        return renderSource(source, { data: userData, signal: activeSignal });
      },
      ...(onSourceLoad && {
        onTileLoad: (tile) => {
          if (!tile?.index) {
            return;
          }
          // `tile.index` is a `ResolvedSource<MosaicT>` from
          // MosaicTileset2D.getTileIndices, which structurally extends
          // MosaicT.
          const source = tile.index as unknown as MosaicT;
          onSourceLoad(source, { data: tile.content?.data });
        },
      }),
      ...(onSourceError && {
        onTileError: (error, tile) => {
          if (!tile?.index) {
            return;
          }
          const source = tile.index as unknown as MosaicT;
          onSourceError(source, { error });
        },
      }),
      ...(onSourceUnload && {
        onTileUnload: (tile) => {
          if (!tile?.index) {
            return;
          }
          const source = tile.index as unknown as MosaicT;
          onSourceUnload(source, { data: tile.content?.data });
        },
      }),
      ...(onViewportLoad && {
        onViewportLoad: (tiles) => {
          onViewportLoad(
            tiles
              .filter((tile) => tile?.index)
              .map((tile) => ({
                source: tile.index as unknown as MosaicT,
                data: tile.content?.data,
              })),
          );
        },
      }),
    });
  }

  override renderLayers(): Layer | null | LayersList {
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
function omitUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
