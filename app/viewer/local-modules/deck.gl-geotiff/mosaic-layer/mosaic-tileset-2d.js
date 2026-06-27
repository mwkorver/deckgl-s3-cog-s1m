import { _Tileset2D as Tileset2D } from "@deck.gl/geo-layers";
import { _sortItemsByDistanceFromViewportCenter as sortItemsByDistanceFromViewportCenter } from "@s3-cog/deck.gl-raster";
export class MosaicTileset2D extends Tileset2D {
    /** Closure returning the parent layer's current sources array. Re-evaluated
     * on each `getTileIndices` call so updates to the layer's `sources` prop
     * propagate without recreating the tileset. */
    getSources;
    /** Access the spatial index on the MosaicLayer instance. */
    getIndex;
    /** Closure returning the parent layer's current source revision. */
    getRevision;
    /** Tracks the last-seen sources array reference so we can detect when the
     * parent layer swaps in a new `sources` prop between viewport changes. */
    _lastSources = null;
    _lastRevision = null;
    constructor(getSources, getIndex, arg3, arg4) {
        let opts;
        let getRevision;
        if (typeof arg3 === "function") {
            getRevision = arg3;
            opts = arg4;
        }
        else {
            opts = arg3;
        }
        super(opts);
        this.getRevision = getRevision;
        this.getIndex = getIndex;
        this.getSources = getSources;
    }
    /**
     * Override to detect source-array or revision changes and force tile-index
     * re-evaluation.
     *
     * The base `Tileset2D.update` only calls `getTileIndices` when the viewport,
     * zRange, or modelMatrix changes. When the parent `MosaicLayer` receives new
     * sources or is force-refreshed at the *same* viewport, the base implementation
     * skips `getTileIndices` entirely and new sources are never discovered.
     *
     * By nulling the private `_viewport` field when a change is detected,
     * we force the base `update` through its viewport-changed branch, which
     * re-calls `getTileIndices` and picks up the new sources while preserving
     * already-cached tiles.
     */
    update(viewport, opts) {
        const currentSources = this.getSources();
        const currentRevision = this.getRevision ? this.getRevision() : null;
        if (currentSources !== this._lastSources ||
            (currentRevision !== null && currentRevision !== this._lastRevision)) {
            this._lastSources = currentSources;
            this._lastRevision = currentRevision;
            // Force the base class to treat this as a viewport change so it
            // re-calls getTileIndices on this cycle.
            // @ts-expect-error — accessing private field on base Tileset2D
            this._viewport = null;
        }
        return super.update(viewport, opts);
    }
    /** The Tileset2D cache key for a source. */
    getTileId(tileIndex) {
        if (!tileIndex) {
            return "";
        }
        // `getTileIndices` always returns `ResolvedSource`s, so an `id` is
        // present on every value deck.gl will pass back here.
        return tileIndex.id ?? "";
    }
    /** Must override to provide a zoom level for the tile. */
    getTileZoom(_tileIndex) {
        return 0;
    }
    /** Must override because our tileIndex does not have x, y, z */
    getTileMetadata(tileIndex) {
        if (!tileIndex) {
            return { id: "", bbox: [0, 0, 0, 0] };
        }
        const { id, bbox } = tileIndex;
        return { id: id ?? "", bbox: bbox ?? [0, 0, 0, 0] };
    }
    getParentIndex(tileIndex) {
        return tileIndex;
    }
    getTileIndices({ viewport, maxZoom, minZoom, }) {
        if (viewport.zoom < (minZoom ?? -Infinity)) {
            return [];
        }
        if (viewport.zoom > (maxZoom ?? Infinity)) {
            return [];
        }
        const index = this.getIndex();
        if (!index) {
            return [];
        }
        const [west, south, east, north] = viewport.getBounds();
        // Add a 15% coordinate search buffer to ensure features partially visible at the screen edges are not prematurely clipped/removed
        const lngBuffer = Math.max((east - west) * 0.15, 0.05);
        const latBuffer = Math.max((north - south) * 0.15, 0.05);
        const indices = index.search(west - lngBuffer, south - latBuffer, east + lngBuffer, north + latBuffer);
        const sources = this.getSources();
        const selectedSources = indices
            .map((sourceIndex) => {
            const source = sources[sourceIndex];
            if (!source) {
                return null;
            }
            return {
                // Remove once https://github.com/visgl/deck.gl/pull/10299
                // is merged and released
                x: 0,
                y: 0,
                z: 0,
                ...source,
                id: source.id ?? String(sourceIndex),
            };
        })
            .filter((s) => s !== null);
        const { maxRequests } = this.opts;
        if (selectedSources.length <= maxRequests) {
            return selectedSources;
        }
        return sortItemsByDistanceFromViewportCenter(selectedSources, viewport, (source) => {
            const [minX, minY, maxX, maxY] = source.bbox;
            return [(minX + maxX) * 0.5, (minY + maxY) * 0.5];
        });
    }
}
//# sourceMappingURL=mosaic-tileset-2d.js.map