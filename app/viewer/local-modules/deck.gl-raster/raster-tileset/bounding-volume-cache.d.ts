import type { OrientedBoundingBox } from "@math.gl/culling";
import type { Bounds, ZRange } from "./types.js";
/**
 * A memoized tile bounding volume, tagged with the elevation range it was
 * computed for (so a `zRange` change can invalidate it).
 */
export interface BoundingVolumeCacheEntry {
    zRange: ZRange;
    boundingVolume: OrientedBoundingBox;
    commonSpaceBounds: Bounds;
}
/**
 * Options for {@link BoundingVolumeCache}.
 */
export interface BoundingVolumeCacheOptions {
    /**
     * Soft cap on the number of cached tile bounding volumes. When a
     * `getTileIndices` traversal begins and the cache holds more than this many
     * entries, the least-recently-used entries are dropped down to roughly half.
     * Eviction never runs mid-traversal (only via {@link BoundingVolumeCache.sweep}),
     * so a single frame is never starved of an entry it computed earlier that
     * same frame. `0` makes every traversal start from an empty cache.
     *
     * @default 65_536
     */
    maxEntries?: number;
}
/**
 * An LRU cache of tile bounding volumes keyed by `"z/x/y"`.
 *
 * The raster tile traversal recomputes a tile's bounding volume (several proj4
 * reprojections plus an oriented-bounding-box fit) only on a cache miss; on a
 * hit it returns the stored volume. A tile's bounding volume depends only on
 * `(z, x, y, zRange)` for a given tileset descriptor, so it is safe to memoize
 * across `getTileIndices` calls (i.e. across animation frames).
 *
 * The key is valid only within a single projection mode. A tile's bounding
 * volume is computed in a different common space under a GlobeView than under
 * Web Mercator, so the cache must be {@link BoundingVolumeCache.clear cleared}
 * when the viewport's projection mode changes. `RasterTileset2D` owns the cache
 * and does this in `getTileIndices` when it detects a globe↔mercator switch.
 */
export declare class BoundingVolumeCache {
    private entries;
    private maxEntries;
    constructor({ maxEntries, }?: BoundingVolumeCacheOptions);
    /** Number of cached entries. */
    get size(): number;
    /**
     * Look up the cached bounding volume for tile `(z, x, y)`. On a hit the entry
     * is marked most-recently-used. Returns `undefined` on a miss.
     */
    get(z: number, x: number, y: number): BoundingVolumeCacheEntry | undefined;
    /** Store the bounding volume for tile `(z, x, y)` as most-recently-used. */
    set(z: number, x: number, y: number, entry: BoundingVolumeCacheEntry): void;
    /**
     * Drop all cached entries. Called by the owner when the viewport's projection
     * mode changes (globe↔mercator), since volumes computed under one projection
     * are not valid under the other.
     */
    clear(): void;
    /**
     * If the cache is over its soft cap, drop least-recently-used entries down to
     * roughly half of `maxEntries`. No-op when at or under the cap. Call once at
     * the start of a traversal, never mid-traversal.
     */
    sweep(): void;
}
//# sourceMappingURL=bounding-volume-cache.d.ts.map