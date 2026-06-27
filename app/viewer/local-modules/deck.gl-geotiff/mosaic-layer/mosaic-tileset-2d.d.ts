import type { Viewport } from "@deck.gl/core";
import { _Tileset2D as Tileset2D } from "@deck.gl/geo-layers";
import type Flatbush from "flatbush";
/** Tile index.
 *
 * Note this is essentially just to type-check deck.gl, since getTileIndices
 * must return a `TileIndex[]`.
 */
export type TileIndex = {
    x: number;
    y: number;
    z: number;
};
/**
 * Minimal required interface of a mosaic item.
 */
export type MosaicSource = {
    /**
     * Optional stable identifier used as this source's tile-cache key in the
     * inner Tileset2D. Defaults to the source's position in the `sources`
     * array. Supply an explicit value when the sources list is reordered or
     * spliced at runtime, so a given source keeps the same cache slot across
     * updates.
     */
    id?: string;
    /**
     * Geographic bounds (WGS84) of the source in [minX, minY, maxX, maxY] format
     */
    bbox: [number, number, number, number];
};
/**
 * A deck.gl Tileset2D for navigating an arbitrary collection of bounding boxes.
 *
 * This is intended to be used for a collection of image mosaics, where we want
 * to render all images currently visible in the viewport.
 *
 * The constructor accepts a `getSources` closure rather than a sources array
 * so that updates to the parent layer's `sources` prop are picked up across
 * the tileset's lifetime. The spatial index is rebuilt on demand whenever the
 * closure returns a new array reference (compared by `===`); mutating the
 * array in place will not be detected.
 */
/** A source augmented with the `TileIndex` fields and a resolved `id`
 * (defaulting to the array position) so deck.gl typing is satisfied and the
 * cache identifier is always defined. */
type ResolvedSource<MosaicT> = TileIndex & MosaicT & {
    id: string;
};
export declare class MosaicTileset2D<MosaicT extends MosaicSource> extends Tileset2D {
    /** Closure returning the parent layer's current sources array. Re-evaluated
     * on each `getTileIndices` call so updates to the layer's `sources` prop
     * propagate without recreating the tileset. */
    private getSources;
    /** Access the spatial index on the MosaicLayer instance. */
    private getIndex;
    /** Closure returning the parent layer's current source revision. */
    private getRevision?;
    /** Tracks the last-seen sources array reference so we can detect when the
     * parent layer swaps in a new `sources` prop between viewport changes. */
    private _lastSources;
    private _lastRevision;
    constructor(getSources: () => MosaicT[], getIndex: () => Flatbush | null, arg3: any, arg4?: any);
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
    update(viewport: Viewport, opts?: {
        zRange: any;
        modelMatrix: any;
    }): number;
    /** The Tileset2D cache key for a source. */
    getTileId(tileIndex: TileIndex): string;
    /** Must override to provide a zoom level for the tile. */
    getTileZoom(_tileIndex: TileIndex): number;
    /** Must override because our tileIndex does not have x, y, z */
    getTileMetadata(tileIndex: TileIndex): Record<string, any>;
    getParentIndex(tileIndex: TileIndex): TileIndex;
    getTileIndices({ viewport, maxZoom, minZoom, }: {
        viewport: Viewport;
        maxZoom?: number;
        minZoom?: number;
    }): ResolvedSource<MosaicT>[];
}
export {};
//# sourceMappingURL=mosaic-tileset-2d.d.ts.map