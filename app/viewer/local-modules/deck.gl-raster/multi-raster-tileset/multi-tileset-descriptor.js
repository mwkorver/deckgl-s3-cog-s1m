/**
 * Create a {@link MultiRasterTilesetDescriptor} from a map of named tilesets.
 *
 * Automatically selects the tileset with the finest
 * {@link RasterTilesetLevel.metersPerPixel} at its highest-resolution level as the
 * primary. All others become secondaries.
 *
 * @param tilesets - Named tilesets, e.g. `new Map([["B04", band10m], ["B11", band20m]])`
 * @throws If `tilesets` is empty
 */
export function createMultiRasterTilesetDescriptor(tilesets) {
    if (tilesets.size === 0) {
        throw new Error("At least one tileset is required");
    }
    let primaryKey = null;
    let finestMpp = Number.POSITIVE_INFINITY;
    for (const [key, descriptor] of tilesets) {
        const finestLevel = descriptor.levels[descriptor.levels.length - 1];
        if (finestLevel && finestLevel.metersPerPixel < finestMpp) {
            finestMpp = finestLevel.metersPerPixel;
            primaryKey = key;
        }
    }
    const primary = tilesets.get(primaryKey);
    const secondaries = new Map();
    for (const [key, descriptor] of tilesets) {
        if (key !== primaryKey) {
            secondaries.set(key, descriptor);
        }
    }
    return {
        primary,
        primaryKey: primaryKey,
        secondaries,
        bounds: primary.projectedBounds,
        projectTo3857: primary.projectTo3857,
        projectTo4326: primary.projectTo4326,
    };
}
/**
 * Select the best {@link RasterTilesetLevel} from a secondary tileset for a given
 * primary {@link RasterTilesetLevel.metersPerPixel}.
 *
 * @param levels - Ordered coarsest-first (index 0 = coarsest), matching
 *   {@link RasterTilesetDescriptor.levels} convention
 * @param primaryMetersPerPixel - The `metersPerPixel` of the current primary
 *   tile's zoom level
 * @param strategy - Selection strategy. Defaults to `"closest-finer"`.
 * @returns The selected {@link RasterTilesetLevel}
 *
 * @see {@link SecondaryLevelStrategy} for available strategies
 */
export function selectSecondaryLevel(levels, primaryMetersPerPixel, strategy = "closest-finer") {
    if (strategy === "closest-finer") {
        // Among levels that are finer-or-equal to the primary, pick the closest
        // (coarsest of the finer-or-equal set). Walk from coarsest to finest,
        // tracking the last level that's <= primary.
        let bestFiner = null;
        for (let i = 0; i < levels.length; i++) {
            if (levels[i].metersPerPixel <= primaryMetersPerPixel) {
                bestFiner = levels[i];
                break;
            }
        }
        // If found, return it; otherwise fall back to the finest available
        return bestFiner ?? levels[levels.length - 1];
    }
    // "closest" — pick the level with the smallest absolute difference
    let best = levels[0];
    let bestDiff = Math.abs(best.metersPerPixel - primaryMetersPerPixel);
    for (let i = 1; i < levels.length; i++) {
        const diff = Math.abs(levels[i].metersPerPixel - primaryMetersPerPixel);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = levels[i];
        }
    }
    return best;
}
/**
 * Check if two {@link RasterTilesetLevel}s have the same grid parameters.
 *
 * Used to detect when sources share a tile grid and can skip UV transform
 * computation (e.g., all 10m Sentinel-2 bands share the same grid).
 *
 * Compares {@link RasterTilesetLevel.matrixWidth}, {@link RasterTilesetLevel.matrixHeight},
 * {@link RasterTilesetLevel.tileWidth}, {@link RasterTilesetLevel.tileHeight}, and
 * {@link RasterTilesetLevel.metersPerPixel}.
 */
export function tilesetLevelsEqual(a, b) {
    return (a.matrixWidth === b.matrixWidth &&
        a.matrixHeight === b.matrixHeight &&
        a.tileWidth === b.tileWidth &&
        a.tileHeight === b.tileHeight &&
        a.metersPerPixel === b.metersPerPixel);
}
//# sourceMappingURL=multi-tileset-descriptor.js.map