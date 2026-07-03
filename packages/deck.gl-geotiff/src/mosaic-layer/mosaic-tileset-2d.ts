import type { Viewport } from "@deck.gl/core";
import type { _Tileset2DProps as Tileset2DProps } from "@deck.gl/geo-layers";
import { _Tileset2D as Tileset2D } from "@deck.gl/geo-layers";
import { _sortItemsByDistanceFromViewportCenter as sortItemsByDistanceFromViewportCenter } from "@s3-cog/deck.gl-raster";
import type Flatbush from "flatbush";

/** Tile index.
 *
 * Note this is essentially just to type-check deck.gl, since getTileIndices
 * must return a `TileIndex[]`.
 */
export type TileIndex = { x: number; y: number; z: number };

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
type ResolvedSource<MosaicT> = TileIndex & MosaicT & { id: string };

export class MosaicTileset2D<MosaicT extends MosaicSource> extends Tileset2D {
  /** Closure returning the parent layer's current sources array. Re-evaluated
   * on each `getTileIndices` call so updates to the layer's `sources` prop
   * propagate without recreating the tileset. */
  private getSources: () => MosaicT[];

  /** Access the spatial index on the MosaicLayer instance. */
  private getIndex: () => Flatbush | null;

  /** Closure returning the parent layer's current source revision. */
  private getRevision?: () => number;

  /** Tracks the last-seen sources array reference so we can detect when the
   * parent layer swaps in a new `sources` prop between viewport changes. */
  private _lastSources: MosaicT[] | null = null;
  private _lastRevision: number | null = null;

  constructor(
    getSources: () => MosaicT[],
    getIndex: () => Flatbush | null,
    arg3: any,
    arg4?: any,
  ) {
    let opts: Tileset2DProps;
    let getRevision: (() => number) | undefined;
    if (typeof arg3 === "function") {
      getRevision = arg3;
      opts = arg4;
    } else {
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
  override update(
    viewport: Viewport,
    opts?: { zRange: any; modelMatrix: any },
  ): number {
    const currentSources = this.getSources();
    const currentRevision = this.getRevision ? this.getRevision() : null;
    if (
      currentSources !== this._lastSources ||
      (currentRevision !== null && currentRevision !== this._lastRevision)
    ) {
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
  override getTileId(tileIndex: TileIndex): string {
    if (!tileIndex) {
      return "";
    }
    // `getTileIndices` always returns `ResolvedSource`s, so an `id` is
    // present on every value deck.gl will pass back here.
    return (tileIndex as ResolvedSource<MosaicT>).id ?? "";
  }

  /** Must override to provide a zoom level for the tile. */
  override getTileZoom(_tileIndex: TileIndex): number {
    return 0;
  }

  /** Must override because our tileIndex does not have x, y, z */
  override getTileMetadata(tileIndex: TileIndex): Record<string, any> {
    if (!tileIndex) {
      return { id: "", bbox: [0, 0, 0, 0] };
    }
    const { id, bbox } = tileIndex as unknown as ResolvedSource<MosaicT>;
    return { id: id ?? "", bbox: bbox ?? [0, 0, 0, 0] };
  }

  override getParentIndex(tileIndex: TileIndex): TileIndex {
    return tileIndex;
  }

  override getTileIndices({
    viewport,
    maxZoom,
    minZoom,
  }: {
    viewport: Viewport;
    maxZoom?: number;
    minZoom?: number;
  }): ResolvedSource<MosaicT>[] {
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
    const indices = index.search(
      west - lngBuffer,
      south - latBuffer,
      east + lngBuffer,
      north + latBuffer,
    );

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
      .filter((s): s is ResolvedSource<MosaicT> => s !== null);

    const { maxRequests } = this.opts;
    if (selectedSources.length <= maxRequests) {
      return selectedSources;
    }

    return sortItemsByDistanceFromViewportCenter(
      selectedSources,
      viewport,
      (source) => {
        const [minX, minY, maxX, maxY] = source.bbox;
        return [(minX + maxX) * 0.5, (minY + maxY) * 0.5] as const;
      },
    );
  }
}
