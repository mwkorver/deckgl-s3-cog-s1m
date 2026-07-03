import type { LayerContext, UpdateParameters } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import type {
  MinimalTileData,
  GetTileDataOptions as RasterTileGetTileDataOptions,
  RasterTileLayerProps,
  RasterTilesetDescriptor,
  RenderTileResult,
} from "@s3-cog/deck.gl-raster";
import { RasterTileLayer } from "@s3-cog/deck.gl-raster";
import { LinearRescale } from "@s3-cog/deck.gl-raster/gpu-modules";
import type {
  ConcurrencyLimiter,
  DecoderPool,
  GeoTIFF,
  Overview,
} from "@s3-cog/geotiff";
import { defaultDecoderPool } from "@s3-cog/geotiff";
import type {
  EpsgResolver,
  ProjectionDefinition,
  ProjJson,
} from "@s3-cog/proj";
import {
  epsgResolver,
  makeClampedForwardTo3857,
  metersPerUnit,
  parseWkt,
} from "@s3-cog/proj";
import proj4 from "proj4";
import { DEFAULT_CONCURRENCY_LIMITER } from "./default-concurrency-limiter.js";
import { fetchGeoTIFF, getGeographicBounds } from "./geotiff/geotiff.js";
import type { TextureDataT } from "./geotiff/render-pipeline.js";
import { inferRenderPipeline } from "./geotiff/render-pipeline.js";
import { geoTiffToDescriptor } from "./geotiff-tileset.js";

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

type COGLayerDataProps<DataT extends MinimalTileData> =
  | {
      /**
       * User-defined method to load data for a tile.
       *
       * Must be provided together with `renderTile`. If neither is provided,
       * the default pipeline is used, which fetches the tile, uploads it as a
       * GPU texture, and renders it using an inferred shader pipeline.
       */
      getTileData: (
        image: GeoTIFF | Overview,
        options: GetTileDataOptions,
      ) => Promise<DataT>;

      /**
       * User-defined method to render data for a tile.
       *
       * Must be provided together with `getTileData`. Receives the value
       * returned by `getTileData` and must return a render pipeline, or
       * `null` to skip rendering for this tile.
       */
      renderTile: (data: DataT) => RenderTileResult | null;
    }
  | {
      getTileData?: undefined;
      renderTile?: undefined;
    };

/**
 * Props that can be passed into the {@link COGLayer}.
 */
export type COGLayerProps<DataT extends MinimalTileData = DefaultDataT> = Omit<
  RasterTileLayerProps<DataT>,
  "tilesetDescriptor" | "getTileData" | "renderTile"
> &
  COGLayerDataProps<DataT> & {
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
    onGeoTIFFLoad?: (
      geotiff: GeoTIFF,
      options: {
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
      },
    ) => void;

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
export class COGLayer<
  DataT extends MinimalTileData = DefaultDataT,
> extends RasterTileLayer<DataT, COGLayerProps<DataT>> {
  static override layerName = "COGLayer";
  // COGLayer's getTileData signature differs from the base class's, so
  // `DefaultProps<COGLayerProps>` is not assignable to
  // `DefaultProps<RasterTileLayerProps>`. Cast to the base static-side type
  // to keep inheritance happy. The only COG-specific default is
  // `epsgResolver`; all behavior still flows from the base class.
  static override defaultProps = {
    ...RasterTileLayer.defaultProps,
    epsgResolver,
    concurrencyLimiter: DEFAULT_CONCURRENCY_LIMITER,
  } as typeof RasterTileLayer.defaultProps;

  declare state: {
    geotiff?: GeoTIFF;
    tilesetDescriptor?: RasterTilesetDescriptor;
    defaultGetTileData?: COGLayerProps<TextureDataT>["getTileData"];
    defaultRenderTile?: COGLayerProps<TextureDataT>["renderTile"];
    /** Aborts the in-flight header read when the `geotiff` prop changes or the
     *  layer is removed
     */
    abortController?: AbortController;
  };

  override initializeState(): void {
    this.setState({ abortController: new AbortController() });
  }

  override finalizeState(context: LayerContext): void {
    this.state.abortController?.abort();
    super.finalizeState(context);
  }

  override updateState(params: UpdateParameters<this>) {
    super.updateState(params);

    const { props, oldProps, changeFlags } = params;

    const needsUpdate =
      Boolean(changeFlags.dataChanged) || props.geotiff !== oldProps.geotiff;

    if (needsUpdate) {
      // Clear stale state so renderLayers returns null until the new GeoTIFF is
      // ready
      this.clearState();
      this._parseGeoTIFF();
    }
  }

  clearState() {
    this.setState({
      geotiff: undefined,
      tilesetDescriptor: undefined,
      defaultGetTileData: undefined,
      defaultRenderTile: undefined,
    });
  }

  async _parseGeoTIFF(): Promise<void> {
    const signal = this.state.abortController?.signal;

    let geotiff: GeoTIFF;
    try {
      geotiff = await fetchGeoTIFF(this.props.geotiff, {
        headers: this.props.headers,
        concurrencyLimiter: this.props.concurrencyLimiter,
        signal,
      });
    } catch (err) {
      // Layer removed mid-open (finalizeState aborted the signal); drop it.
      if (signal?.aborted) {
        return;
      }
      throw err;
    }
    const sourceProjectionInput = this.props.sourceProjection ?? geotiff.crs;
    const sourceProjection =
      typeof sourceProjectionInput === "number"
        ? await this.props.epsgResolver!(sourceProjectionInput)
        : "coordinate_system" in sourceProjectionInput
          ? parseWkt(sourceProjectionInput as ProjJson)
          : sourceProjectionInput;

    if (signal?.aborted) {
      return;
    }

    // @ts-expect-error - proj4 typings are incomplete and don't support
    // wkt-parser input
    const converter4326 = proj4(sourceProjection, "EPSG:4326");
    const projectTo4326 = (x: number, y: number) =>
      converter4326.forward<[number, number]>([x, y], false);
    const projectFrom4326 = (x: number, y: number) =>
      converter4326.inverse<[number, number]>([x, y], false);

    // @ts-expect-error - proj4 typings are incomplete and don't support
    // wkt-parser input
    const converter3857 = proj4(sourceProjection, "EPSG:3857");
    const projectTo3857 = makeClampedForwardTo3857(
      (x: number, y: number) =>
        converter3857.forward<[number, number]>([x, y], false),
      projectTo4326,
    );
    const projectFrom3857 = (x: number, y: number) =>
      converter3857.inverse<[number, number]>([x, y], false);

    const units = sourceProjection.units;
    if (!units) {
      throw new Error(
        "Source projection is missing 'units' property, cannot compute meters per unit",
      );
    }
    const mpu = metersPerUnit(units as Parameters<typeof metersPerUnit>[0], {
      semiMajorAxis: sourceProjection.datum?.a ?? sourceProjection.a,
    });

    const tilesetDescriptor = geoTiffToDescriptor(geotiff, {
      projectTo4326,
      projectFrom4326,
      projectTo3857,
      projectFrom3857,
      mpu,
    });

    if (this.props.onGeoTIFFLoad) {
      const geographicBounds = getGeographicBounds(geotiff, converter4326);
      this.props.onGeoTIFFLoad(geotiff, {
        projection: sourceProjection,
        geographicBounds,
      });
    }

    let defaultGetTileData: COGLayerProps<TextureDataT>["getTileData"];
    let defaultRenderTile: COGLayerProps<TextureDataT>["renderTile"];
    if (!this.props.getTileData || !this.props.renderTile) {
      ({ getTileData: defaultGetTileData, renderTile: defaultRenderTile } =
        inferRenderPipeline(geotiff, this.context.device));
    }

    this.setState({
      geotiff,
      tilesetDescriptor,
      defaultGetTileData,
      defaultRenderTile,
    });
  }

  protected override _tilesetDescriptor() {
    return this.state.tilesetDescriptor;
  }

  /**
   * Adapts the user-facing `(image, { x, y, ... }) => Promise<DataT>` signature
   * into RasterTileLayer's `(tile, { signal, device }) => Promise<DataT>`.
   */
  protected override _getTileDataCallback() {
    const geotiff = this.state.geotiff;

    if (!geotiff) {
      return undefined;
    }

    const userFn = this.props.getTileData ?? this.state.defaultGetTileData;

    if (!userFn) {
      return undefined;
    }

    type RasterGetTileData = NonNullable<
      RasterTileLayerProps<DataT>["getTileData"]
    >;
    const wrapped: RasterGetTileData = async (tile, options) => {
      const { x, y, z } = tile.index;
      // Levels are emitted coarsest-first with the full-res geotiff appended
      // last, so z === overviews.length picks the full-res image and lower z
      // picks the corresponding overview from the finest-first list.
      const image =
        z === geotiff.overviews.length
          ? geotiff
          : geotiff.overviews[geotiff.overviews.length - 1 - z]!;
      return userFn(image, {
        device: options.device,
        x,
        y,
        z,
        signal: options.signal,
        pool: this.props.pool ?? defaultDecoderPool(),
      }) as Promise<DataT>;
    };
    return wrapped;
  }

  protected override _renderTileCallback() {
    const userFn = this.props.renderTile ?? this.state.defaultRenderTile;

    if (!userFn) {
      return undefined;
    }

    const { domain } = this.props;
    if (!domain) {
      return userFn as NonNullable<RasterTileLayerProps<DataT>["renderTile"]>;
    }

    const geotiff = this.state.geotiff;
    if (!geotiff) {
      return userFn as NonNullable<RasterTileLayerProps<DataT>["renderTile"]>;
    }

    const { bitsPerSample } = geotiff.cachedTags;
    if (
      !bitsPerSample ||
      bitsPerSample.length === 0 ||
      bitsPerSample[0] === undefined
    ) {
      return userFn as NonNullable<RasterTileLayerProps<DataT>["renderTile"]>;
    }

    const bitWidth = bitsPerSample[0];
    const typeMax = 2 ** bitWidth - 1;

    // Avoid rescaling if it's identity (e.g. [0, typeMax])
    if (domain[0] === 0 && domain[1] === typeMax) {
      return userFn as NonNullable<RasterTileLayerProps<DataT>["renderTile"]>;
    }

    const rescaleMin = domain[0] / typeMax;
    const rescaleMax = domain[1] / typeMax;

    return ((tileData: any) => {
      const tileResult = (userFn as any)(tileData);
      if (!tileResult) {
        return null;
      }
      const pipeline = tileResult.renderPipeline
        ? [...tileResult.renderPipeline]
        : [];
      pipeline.push({
        module: LinearRescale,
        props: {
          rescaleMin,
          rescaleMax,
        },
      });
      return {
        ...tileResult,
        renderPipeline: pipeline,
      };
    }) as any;
  }
}
