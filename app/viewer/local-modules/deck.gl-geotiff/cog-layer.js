import { RasterTileLayer } from "@s3-cog/deck.gl-raster";
import { defaultDecoderPool } from "@s3-cog/geotiff";
import { epsgResolver, makeClampedForwardTo3857, metersPerUnit, parseWkt, } from "@s3-cog/proj";
import proj4 from "proj4";
import { DEFAULT_CONCURRENCY_LIMITER } from "./default-concurrency-limiter.js";
import { fetchGeoTIFF, getGeographicBounds } from "./geotiff/geotiff.js";
import { inferRenderPipeline } from "./geotiff/render-pipeline.js";
import { geoTiffToDescriptor } from "./geotiff-tileset.js";
import { LinearRescale } from "@s3-cog/deck.gl-raster/gpu-modules";
/**
 * COGLayer renders a COG using a tiled approach with reprojection.
 */
export class COGLayer extends RasterTileLayer {
    static layerName = "COGLayer";
    // COGLayer's getTileData signature differs from the base class's, so
    // `DefaultProps<COGLayerProps>` is not assignable to
    // `DefaultProps<RasterTileLayerProps>`. Cast to the base static-side type
    // to keep inheritance happy. The only COG-specific default is
    // `epsgResolver`; all behavior still flows from the base class.
    static defaultProps = {
        ...RasterTileLayer.defaultProps,
        epsgResolver,
        concurrencyLimiter: DEFAULT_CONCURRENCY_LIMITER,
    };
    initializeState() {
        this.setState({ abortController: new AbortController() });
    }
    finalizeState(context) {
        this.state.abortController?.abort();
        super.finalizeState(context);
    }
    updateState(params) {
        super.updateState(params);
        const { props, oldProps, changeFlags } = params;
        const needsUpdate = Boolean(changeFlags.dataChanged) || props.geotiff !== oldProps.geotiff;
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
    async _parseGeoTIFF() {
        const signal = this.state.abortController?.signal;
        let geotiff;
        try {
            geotiff = await fetchGeoTIFF(this.props.geotiff, {
                headers: this.props.headers,
                concurrencyLimiter: this.props.concurrencyLimiter,
                signal,
            });
        }
        catch (err) {
            // Layer removed mid-open (finalizeState aborted the signal); drop it.
            if (signal?.aborted) {
                return;
            }
            throw err;
        }
        const sourceProjectionInput = this.props.sourceProjection ?? geotiff.crs;
        const sourceProjection = typeof sourceProjectionInput === "number"
            ? await this.props.epsgResolver(sourceProjectionInput)
            : "coordinate_system" in sourceProjectionInput
                ? parseWkt(sourceProjectionInput)
                : sourceProjectionInput;
        if (signal?.aborted) {
            return;
        }
        // @ts-expect-error - proj4 typings are incomplete and don't support
        // wkt-parser input
        const converter4326 = proj4(sourceProjection, "EPSG:4326");
        const projectTo4326 = (x, y) => converter4326.forward([x, y], false);
        const projectFrom4326 = (x, y) => converter4326.inverse([x, y], false);
        // @ts-expect-error - proj4 typings are incomplete and don't support
        // wkt-parser input
        const converter3857 = proj4(sourceProjection, "EPSG:3857");
        const projectTo3857 = makeClampedForwardTo3857((x, y) => converter3857.forward([x, y], false), projectTo4326);
        const projectFrom3857 = (x, y) => converter3857.inverse([x, y], false);
        const units = sourceProjection.units;
        if (!units) {
            throw new Error("Source projection is missing 'units' property, cannot compute meters per unit");
        }
        const mpu = metersPerUnit(units, {
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
        let defaultGetTileData;
        let defaultRenderTile;
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
    _tilesetDescriptor() {
        return this.state.tilesetDescriptor;
    }
    /**
     * Adapts the user-facing `(image, { x, y, ... }) => Promise<DataT>` signature
     * into RasterTileLayer's `(tile, { signal, device }) => Promise<DataT>`.
     */
    _getTileDataCallback() {
        const geotiff = this.state.geotiff;
        if (!geotiff) {
            return undefined;
        }
        const userFn = this.props.getTileData ?? this.state.defaultGetTileData;
        if (!userFn) {
            return undefined;
        }
        const wrapped = async (tile, options) => {
            const { x, y, z } = tile.index;
            // Levels are emitted coarsest-first with the full-res geotiff appended
            // last, so z === overviews.length picks the full-res image and lower z
            // picks the corresponding overview from the finest-first list.
            const image = z === geotiff.overviews.length
                ? geotiff
                : geotiff.overviews[geotiff.overviews.length - 1 - z];
            return userFn(image, {
                device: options.device,
                x,
                y,
                z,
                signal: options.signal,
                pool: this.props.pool ?? defaultDecoderPool(),
            });
        };
        return wrapped;
    }
    _renderTileCallback() {
        const userFn = this.props.renderTile ?? this.state.defaultRenderTile;
        if (!userFn) {
            return undefined;
        }
        const { domain } = this.props;
        if (!domain) {
            return userFn;
        }
        const geotiff = this.state.geotiff;
        if (!geotiff) {
            return userFn;
        }
        const { bitsPerSample } = geotiff.cachedTags;
        if (!bitsPerSample || bitsPerSample.length === 0 || bitsPerSample[0] === undefined) {
            return userFn;
        }
        const bitWidth = bitsPerSample[0];
        const typeMax = Math.pow(2, bitWidth) - 1;
        // Avoid rescaling if it's identity (e.g. [0, typeMax])
        if (domain[0] === 0 && domain[1] === typeMax) {
            return userFn;
        }
        const rescaleMin = domain[0] / typeMax;
        const rescaleMax = domain[1] / typeMax;
        return ((tileData) => {
            const tileResult = userFn(tileData);
            if (!tileResult) {
                return null;
            }
            const pipeline = tileResult.renderPipeline ? [...tileResult.renderPipeline] : [];
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
        });
    }
}
//# sourceMappingURL=cog-layer.js.map