const DEFAULT_MAX_ENTRIES = 65_536;
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
export class BoundingVolumeCache {
    entries = new Map();
    maxEntries;
    constructor({ maxEntries = DEFAULT_MAX_ENTRIES, } = {}) {
        this.maxEntries = Math.max(0, maxEntries);
    }
    /** Number of cached entries. */
    get size() {
        return this.entries.size;
    }
    /**
     * Look up the cached bounding volume for tile `(z, x, y)`. On a hit the entry
     * is marked most-recently-used. Returns `undefined` on a miss.
     */
    get(z, x, y) {
        const key = `${z}/${x}/${y}`;
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        // Re-insert to move the key to the most-recently-used end of the Map.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }
    /** Store the bounding volume for tile `(z, x, y)` as most-recently-used. */
    set(z, x, y, entry) {
        const key = `${z}/${x}/${y}`;
        this.entries.delete(key);
        this.entries.set(key, entry);
    }
    /**
     * Drop all cached entries. Called by the owner when the viewport's projection
     * mode changes (globe↔mercator), since volumes computed under one projection
     * are not valid under the other.
     */
    clear() {
        this.entries.clear();
    }
    /**
     * If the cache is over its soft cap, drop least-recently-used entries down to
     * roughly half of `maxEntries`. No-op when at or under the cap. Call once at
     * the start of a traversal, never mid-traversal.
     */
    sweep() {
        if (this.entries.size <= this.maxEntries) {
            return;
        }
        const target = Math.floor(this.maxEntries / 2);
        const excess = this.entries.size - target;
        const keysToDelete = [];
        for (const key of this.entries.keys()) {
            keysToDelete.push(key);
            if (keysToDelete.length >= excess) {
                break;
            }
        }
        for (const key of keysToDelete) {
            this.entries.delete(key);
        }
    }
}
//# sourceMappingURL=bounding-volume-cache.js.map