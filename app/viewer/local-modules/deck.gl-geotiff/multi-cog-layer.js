import { PathLayer, TextLayer } from "@deck.gl/layers";
import { createMultiRasterTilesetDescriptor, RasterTileLayer, resolveSecondaryTiles, selectSecondaryLevel, tilesetLevelsEqual, } from "@s3-cog/deck.gl-raster";
import { buildCompositeBandsProps, CompositeBands, } from "@s3-cog/deck.gl-raster/gpu-modules";
import { assembleTiles, defaultDecoderPool } from "@s3-cog/geotiff";
import { epsgResolver as defaultEpsgResolver, makeClampedForwardTo3857, metersPerUnit, parseWkt, } from "@s3-cog/proj";
import proj4 from "proj4";
import { DEFAULT_CONCURRENCY_LIMITER } from "./default-concurrency-limiter.js";
import { fetchGeoTIFF, getGeographicBounds } from "./geotiff/geotiff.js";
import { geoTiffToDescriptor } from "./geotiff-tileset.js";
/**
 * Color palette for debug overlays.
 *
 * Index 0 is the primary tileset (red outline, white text).
 * Indices 1+ cycle through distinct colors for secondary tilesets.
 */
const DEBUG_COLORS = [
    { outline: [255, 0, 0, 255], text: [255, 255, 255, 255] }, // primary: red outline, white text
    { outline: [0, 255, 255, 255], text: [0, 255, 255, 255] }, // cyan
    { outline: [255, 255, 0, 255], text: [255, 255, 0, 255] }, // yellow
    { outline: [255, 0, 255, 255], text: [255, 0, 255, 255] }, // magenta
    { outline: [0, 255, 128, 255], text: [0, 255, 128, 255] }, // lime
];
const defaultProps = {
    ...RasterTileLayer.defaultProps,
    epsgResolver: { type: "accessor", value: defaultEpsgResolver },
    debugLevel: { type: "number", value: 1 },
    concurrencyLimiter: DEFAULT_CONCURRENCY_LIMITER,
};
/**
 * Open every configured source's GeoTIFF in parallel and resolve each one's
 * projection. Returns `null` when `signal` aborts mid-open (the layer was
 * removed), so the caller can bail without applying stale state.
 */
async function openCogSources(entries, options) {
    const { concurrencyLimiter, epsgResolver, signal } = options;
    try {
        return await Promise.all(entries.map(async ([name, config]) => {
            const geotiff = await fetchGeoTIFF(config.url, {
                concurrencyLimiter,
                signal,
            });
            const crs = geotiff.crs;
            const sourceProjection = typeof crs === "number" ? await epsgResolver(crs) : parseWkt(crs);
            return { name, geotiff, sourceProjection };
        }));
    }
    catch (err) {
        // Layer removed mid-open (finalizeState aborted the signal); bail.
        if (signal?.aborted) {
            return null;
        }
        throw err;
    }
}
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
export class MultiCOGLayer extends RasterTileLayer {
    static layerName = "MultiCOGLayer";
    // Same casting trick as COGLayer: defaultProps shape diverges from the
    // base's parameterized type, so cast through to satisfy the static-side
    // check while keeping subclass-specific defaults.
    static defaultProps = defaultProps;
    initializeState() {
        this.setState({
            sources: null,
            multiDescriptor: null,
            // One controller for the layer's lifetime; aborted in finalizeState so
            // header reads still in flight when the layer is removed are cancelled.
            abortController: new AbortController(),
        });
    }
    finalizeState(context) {
        this.state.abortController?.abort();
        super.finalizeState(context);
    }
    updateState({ changeFlags, props, oldProps, }) {
        if (changeFlags.dataChanged || props.sources !== oldProps.sources) {
            // Reset state so renderLayers() returns null while we re-open COGs.
            // Without this, the TileLayer renders with new props but stale state,
            // caching tiles with the wrong bands.
            this.setState({
                sources: null,
                multiDescriptor: null,
            });
            this._parseAllSources();
        }
    }
    /**
     * Open all configured COG sources in parallel, compute shared projection
     * functions, and build the {@link MultiRasterTilesetDescriptor}.
     *
     * All sources are assumed to share the same CRS; the projection of the
     * first source is used for the shared coordinate converters.
     *
     * @returns Resolves when all sources have been opened and state has been set.
     */
    async _parseAllSources() {
        const { sources } = this.props;
        const entries = Object.entries(sources);
        if (entries.length === 0) {
            return;
        }
        const signal = this.state.abortController?.signal;
        const cogSources = await openCogSources(entries, {
            concurrencyLimiter: this.props.concurrencyLimiter,
            epsgResolver: this.props.epsgResolver,
            signal,
        });
        if (cogSources === null) {
            return;
        }
        // Use the first source's projection for shared projection functions
        // (all sources must share the same CRS)
        const firstCogSource = cogSources[0];
        const sourceProjection = firstCogSource.sourceProjection;
        // @ts-expect-error - proj4 typings are incomplete and don't support
        // wkt-parser input
        const converter4326 = proj4(sourceProjection, "EPSG:4326");
        const forwardTo4326 = (x, y) => converter4326.forward([x, y], false);
        const inverseFrom4326 = (x, y) => converter4326.inverse([x, y], false);
        // @ts-expect-error - proj4 typings are incomplete and don't support
        // wkt-parser input
        const converter3857 = proj4(sourceProjection, "EPSG:3857");
        const forwardTo3857 = makeClampedForwardTo3857((x, y) => converter3857.forward([x, y], false), forwardTo4326);
        const inverseFrom3857 = (x, y) => converter3857.inverse([x, y], false);
        const units = sourceProjection.units;
        if (!units) {
            throw new Error("Source projection is missing 'units' property, cannot compute meters per unit");
        }
        const mpu = metersPerUnit(units, {
            semiMajorAxis: sourceProjection.datum?.a ?? sourceProjection.a,
        });
        // Build TilesetDescriptors
        const tilesetMap = new Map();
        const sourceMap = new Map();
        for (const cogSource of cogSources) {
            const descriptor = geoTiffToDescriptor(cogSource.geotiff, {
                projectTo4326: forwardTo4326,
                projectFrom4326: inverseFrom4326,
                projectTo3857: forwardTo3857,
                projectFrom3857: inverseFrom3857,
                mpu,
            });
            tilesetMap.set(cogSource.name, descriptor);
            sourceMap.set(cogSource.name, { geotiff: cogSource.geotiff });
        }
        const multiDescriptor = createMultiRasterTilesetDescriptor(tilesetMap);
        // Layer was removed while we resolved projections; don't setState on a
        // finalized layer.
        if (signal?.aborted) {
            return;
        }
        this.setState({
            sources: sourceMap,
            multiDescriptor,
        });
        if (this.props.onGeoTIFFLoad) {
            const primaryKey = multiDescriptor.primaryKey;
            const primaryGeotiff = sourceMap.get(primaryKey).geotiff;
            const geographicBounds = getGeographicBounds(primaryGeotiff, converter4326);
            const geotiffMap = new Map();
            for (const [name, state] of sourceMap) {
                geotiffMap.set(name, state.geotiff);
            }
            this.props.onGeoTIFFLoad(geotiffMap, { primaryKey, geographicBounds });
        }
    }
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
    async _getTileData(tile, options) {
        const { x, y, z } = tile.index;
        const { multiDescriptor, sources } = this.state;
        const pool = this.props.pool ?? defaultDecoderPool();
        const { device, signal: combinedSignal } = options;
        // Compute per-tile reprojection transforms from the primary descriptor
        const primaryKey = multiDescriptor.primaryKey;
        const primaryLevel = multiDescriptor.primary.levels[z];
        const { forwardTransform, inverseTransform } = primaryLevel.tileTransform(x, y);
        // Collect fetch promises for all bands
        const bandPromises = [];
        for (const [name, sourceState] of sources) {
            const descriptor = name === primaryKey
                ? multiDescriptor.primary
                : multiDescriptor.secondaries.get(name);
            const isPrimary = name === primaryKey ||
                tilesetLevelsEqual(descriptor.levels[z] ?? descriptor.levels[0], primaryLevel);
            if (isPrimary) {
                // Primary-grid source: fetch tile directly with identity UV transform
                bandPromises.push(this._fetchPrimaryBand(name, sourceState, {
                    x,
                    y,
                    z,
                    pool,
                    signal: combinedSignal,
                    device,
                }));
            }
            else {
                // Secondary source: resolve covering tiles and fetch
                bandPromises.push(this._fetchSecondaryBand(name, sourceState, {
                    descriptor,
                    primaryLevel,
                    primaryCol: x,
                    primaryRow: y,
                    primaryZ: z,
                    pool,
                    signal: combinedSignal,
                    device,
                    debug: this.props.debug ?? false,
                }));
            }
        }
        const bandEntries = await Promise.all(bandPromises);
        const bands = new Map(bandEntries.map(([name, data]) => [name, data]));
        // Collect debug info from secondary bands
        let debugInfo;
        if (this.props.debug) {
            const debugBands = new Map();
            for (const [name, , bandDebug] of bandEntries) {
                if (bandDebug) {
                    debugBands.set(name, bandDebug);
                }
            }
            debugInfo = { bands: debugBands };
        }
        const byteLength = [...bands.values()].reduce((sum, band) => sum + band.byteLength, 0);
        return {
            bands,
            forwardTransform,
            inverseTransform,
            width: primaryLevel.tileWidth,
            height: primaryLevel.tileHeight,
            byteLength,
            debugInfo,
        };
    }
    _tilesetDescriptor() {
        return this.state.multiDescriptor?.primary;
    }
    _getTileDataCallback() {
        if (!this.state.multiDescriptor || !this.state.sources) {
            return undefined;
        }
        return (tile, options) => this._getTileData(tile, options);
    }
    _renderTileCallback() {
        if (!this.state.multiDescriptor) {
            return undefined;
        }
        return (data) => this._buildRenderResult(data);
    }
    _renderDebug(tile, data) {
        if (!data?.debugInfo) {
            return super._renderDebug(tile, data);
        }
        const projectTo4326 = this.state.multiDescriptor?.primary.projectTo4326;
        if (!projectTo4326) {
            return super._renderDebug(tile, data);
        }
        return this._renderDebugLayers(`${this.id}-${tile.id}`, tile, data, projectTo4326);
    }
    /**
     * Build the per-tile render pipeline. Mirrors the band-binding logic that
     * previously lived inline in `_renderSubLayers`.
     *
     * Returns `null` when the configured `composite` references a band that
     * isn't present in the cached tile data (happens transiently while sources
     * are switching).
     */
    _buildRenderResult(data) {
        const { bands } = data;
        const composite = this.props.composite ?? {
            r: [...bands.keys()][0],
        };
        const requiredBands = [
            composite.r,
            composite.g,
            composite.b,
            composite.a,
        ].filter((n) => n != null);
        if (requiredBands.some((name) => !bands.has(name))) {
            return null;
        }
        const compositeBandsProps = buildCompositeBandsProps(composite, bands);
        const renderPipeline = [
            {
                module: CompositeBands,
                props: compositeBandsProps,
            },
            ...(this.props.renderPipeline ?? []),
        ];
        return { renderPipeline };
    }
    /**
     * Fetch a single tile for a source that shares the primary tile grid.
     *
     * @returns A `[name, BandTileData, null]` tuple with identity UV transform
     *   and no debug info (primary bands don't need it).
     */
    async _fetchPrimaryBand(name, sourceState, opts) {
        const { x, y, z, pool, signal, device } = opts;
        const image = selectImage(sourceState.geotiff, z);
        const tile = await image.fetchTile(x, y, {
            boundless: true,
            pool,
            signal,
        });
        const texture = createBandTexture(device, tile.array);
        const arr = tile.array;
        const byteLength = arr.layout === "pixel-interleaved"
            ? arr.data.byteLength
            : arr.bands.reduce((sum, b) => sum + b.byteLength, 0);
        return [
            name,
            {
                texture,
                uvTransform: [0, 0, 1, 1],
                width: arr.width,
                height: arr.height,
                byteLength,
            },
            null,
        ];
    }
    /**
     * Fetch covering tiles for a secondary source and stitch them into a
     * single texture using {@link assembleTiles}.
     *
     * @returns A `[name, BandTileData, BandDebugInfo | null]` tuple with the
     *   computed UV transform and optional debug metadata.
     */
    async _fetchSecondaryBand(name, sourceState, opts) {
        const { descriptor, primaryLevel, primaryCol, primaryRow, primaryZ, pool, signal, device, } = opts;
        // Select the best secondary level
        const primaryMpp = this.state.multiDescriptor.primary.levels[primaryZ].metersPerPixel;
        const secondaryLevel = selectSecondaryLevel(descriptor.levels, primaryMpp);
        const secondaryZ = descriptor.levels.indexOf(secondaryLevel);
        // Resolve covering tile indices and UV transform
        const resolution = resolveSecondaryTiles(primaryLevel, primaryCol, primaryRow, secondaryLevel, secondaryZ);
        // Collect debug info if requested
        let debugInfo = null;
        if (opts.debug) {
            const secondaryTileCorners = resolution.tileIndices.map((idx) => secondaryLevel.projectedTileCorners(idx.x, idx.y));
            debugInfo = {
                secondaryTileCorners,
                secondaryZ,
                uvTransform: resolution.uvTransform,
                stitchedWidth: resolution.stitchedWidth,
                stitchedHeight: resolution.stitchedHeight,
                tileCount: resolution.tileIndices.length,
                metersPerPixel: secondaryLevel.metersPerPixel,
            };
        }
        // Fetch all covering tiles via fetchTiles
        const image = selectImage(sourceState.geotiff, secondaryZ);
        const xy = resolution.tileIndices.map((idx) => [
            idx.x,
            idx.y,
        ]);
        const tiles = await image.fetchTiles(xy, {
            boundless: true,
            pool,
            signal,
        });
        // Assemble into a single RasterArray (handles stitching + typed array preservation)
        const assembled = assembleTiles(tiles, {
            width: resolution.stitchedWidth,
            height: resolution.stitchedHeight,
            tileWidth: secondaryLevel.tileWidth,
            tileHeight: secondaryLevel.tileHeight,
            minCol: resolution.minCol,
            minRow: resolution.minRow,
        });
        const texture = createBandTexture(device, assembled);
        const assembledByteLength = assembled.layout === "pixel-interleaved"
            ? assembled.data.byteLength
            : assembled.bands.reduce((sum, b) => sum + b.byteLength, 0);
        return [
            name,
            {
                texture,
                uvTransform: resolution.uvTransform,
                width: assembled.width,
                height: assembled.height,
                byteLength: assembledByteLength,
            },
            debugInfo,
        ];
    }
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
    _renderDebugLayers(tileId, tile, data, forwardTo4326) {
        const layers = [];
        const debugLevel = this.props.debugLevel ?? 1;
        const { multiDescriptor } = this.state;
        if (!multiDescriptor) {
            return layers;
        }
        const { x, y, z } = tile.index;
        const primaryLevel = multiDescriptor.primary.levels[z];
        if (!primaryLevel) {
            return layers;
        }
        // --- Primary tile outline and label ---
        const primaryCrsCorners = primaryLevel.projectedTileCorners(x, y);
        const { path: primaryPath, center: primaryCenter } = cornersToWgs84Path(primaryCrsCorners, forwardTo4326);
        const primaryColor = DEBUG_COLORS[0];
        layers.push(new PathLayer({
            id: `${tileId}-debug-primary-outline`,
            data: [primaryPath],
            getPath: (d) => d,
            getColor: primaryColor.outline,
            getWidth: 2,
            widthUnits: "pixels",
            pickable: false,
        }));
        // Build primary label text
        let primaryText = `x=${x} y=${y} z=${z}`;
        if (debugLevel >= 2) {
            primaryText += `  ${data.width}x${data.height}`;
        }
        if (debugLevel >= 3) {
            primaryText += `  ${primaryLevel.metersPerPixel.toFixed(1)}m/px`;
        }
        // Count total label lines for vertical stacking
        const secondaryNames = data.debugInfo
            ? [...data.debugInfo.bands.keys()]
            : [];
        const totalLines = 1 + secondaryNames.length;
        const lineSpacing = 18; // pixels
        const topOffset = ((totalLines - 1) * lineSpacing) / 2;
        layers.push(new TextLayer({
            id: `${tileId}-debug-primary-label`,
            data: [
                {
                    position: primaryCenter,
                    text: primaryText,
                },
            ],
            getColor: primaryColor.text,
            getSize: 14,
            getPixelOffset: [0, -topOffset],
            sizeUnits: "pixels",
            outlineWidth: 3,
            outlineColor: [0, 0, 0, 255],
            fontSettings: { sdf: true },
        }));
        // --- Secondary tile outlines and labels ---
        if (!data.debugInfo) {
            return layers;
        }
        let secondaryIdx = 0;
        for (const [name, info] of data.debugInfo.bands) {
            const colorEntry = DEBUG_COLORS[1 + (secondaryIdx % (DEBUG_COLORS.length - 1))];
            // Draw outline for each secondary tile
            for (let i = 0; i < info.secondaryTileCorners.length; i++) {
                const { path: secondaryPath } = cornersToWgs84Path(info.secondaryTileCorners[i], forwardTo4326);
                layers.push(new PathLayer({
                    id: `${tileId}-debug-${name}-outline-${i}`,
                    data: [secondaryPath],
                    getPath: (d) => d,
                    getColor: colorEntry.outline,
                    getWidth: 2,
                    widthUnits: "pixels",
                    pickable: false,
                }));
            }
            // Build secondary label text
            const mpp = info.metersPerPixel.toFixed(1);
            let labelText = `${name}: ${mpp}m z=${info.secondaryZ}`;
            if (debugLevel >= 2) {
                const uv = info.uvTransform;
                labelText += `  uv=[${uv.map((v) => v.toFixed(2)).join(",")}]  ${info.tileCount} tiles`;
            }
            if (debugLevel >= 3) {
                labelText += `  stitch=${info.stitchedWidth}x${info.stitchedHeight}`;
            }
            const lineOffset = -topOffset + (1 + secondaryIdx) * lineSpacing;
            layers.push(new TextLayer({
                id: `${tileId}-debug-${name}-label`,
                data: [
                    {
                        position: primaryCenter,
                        text: labelText,
                    },
                ],
                getColor: colorEntry.text,
                getSize: 12,
                getPixelOffset: [0, lineOffset],
                sizeUnits: "pixels",
                outlineWidth: 2,
                outlineColor: [0, 0, 0, 255],
                fontSettings: { sdf: true },
            }));
            secondaryIdx++;
        }
        return layers;
    }
}
/**
 * Select the correct GeoTIFF image (full-res or overview) for a zoom level.
 *
 * z=0 is the coarsest overview, z=max is full resolution.
 */
function selectImage(geotiff, z) {
    const images = [geotiff, ...geotiff.overviews];
    return images[images.length - 1 - z];
}
/**
 * Create a GPU texture from a {@link RasterArray}.
 *
 * Infers the texture format from the typed array type. Currently supports
 * single-band `Uint8Array` (`r8unorm`) and `Uint16Array` (`r16unorm`).
 *
 * TODO: use `inferTextureFormat` from `texture.ts` for full format support.
 */
function createBandTexture(device, array) {
    if (array.layout !== "pixel-interleaved") {
        throw new Error("Band-separate layout not yet supported in MultiCOGLayer");
    }
    const { data, width, height } = array;
    let format;
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
        format = "r8unorm";
    }
    else if (data instanceof Uint16Array) {
        format = "r16unorm";
    }
    else {
        throw new Error(`Unsupported typed array type: ${data.constructor.name}. ` +
            "Currently only Uint8Array and Uint16Array are supported.");
    }
    return device.createTexture({
        data,
        format,
        width,
        height,
        sampler: { minFilter: "linear", magFilter: "linear" },
    });
}
/**
 * Project CRS tile corners to WGS84 and return a closed path suitable for
 * PathLayer, plus the center point for label placement.
 *
 * @param corners - Tile corners in the source CRS.
 * @param projectTo4326 - Projection function from source CRS to WGS84.
 * @returns A closed `[topLeft, topRight, bottomRight, bottomLeft, topLeft]`
 *   path and the geographic center.
 */
function cornersToWgs84Path(corners, projectTo4326) {
    const topLeft = projectTo4326(corners.topLeft[0], corners.topLeft[1]);
    const topRight = projectTo4326(corners.topRight[0], corners.topRight[1]);
    const bottomRight = projectTo4326(corners.bottomRight[0], corners.bottomRight[1]);
    const bottomLeft = projectTo4326(corners.bottomLeft[0], corners.bottomLeft[1]);
    return {
        path: [topLeft, topRight, bottomRight, bottomLeft, topLeft],
        center: [
            (topLeft[0] + bottomRight[0]) / 2,
            (topLeft[1] + bottomRight[1]) / 2,
        ],
    };
}
//# sourceMappingURL=multi-cog-layer.js.map