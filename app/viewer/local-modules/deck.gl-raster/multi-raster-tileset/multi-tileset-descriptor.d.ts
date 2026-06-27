import type { RasterTilesetDescriptor, RasterTilesetLevel } from "../raster-tileset/tileset-interface.js";
import type { Bounds, ProjectionFunction } from "../raster-tileset/types.js";
/**
 * Groups N {@link RasterTilesetDescriptor}s representing the same geographic extent
 * at different native resolutions.
 *
 * The {@link primary} tileset (finest resolution) drives tile traversal;
 * {@link secondaries} are consulted at fetch time to resolve covering tiles
 * and compute UV transforms.
 *
 * @see {@link createMultiRasterTilesetDescriptor} to construct from a named map of tilesets
 */
export interface MultiRasterTilesetDescriptor {
    /** Highest-resolution tileset — drives tile traversal. */
    primary: RasterTilesetDescriptor;
    /** The key under which the primary was provided to {@link createMultiRasterTilesetDescriptor}. */
    primaryKey: string;
    /** Lower-resolution tilesets, keyed by user-defined name. */
    secondaries: Map<string, RasterTilesetDescriptor>;
    /** Shared CRS bounds (from primary's {@link RasterTilesetDescriptor.projectedBounds}). */
    bounds: Bounds;
    /** Shared projection: source CRS -> EPSG:3857. */
    projectTo3857: ProjectionFunction;
    /** Shared projection: source CRS -> EPSG:4326. */
    projectTo4326: ProjectionFunction;
}
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
export declare function createMultiRasterTilesetDescriptor(tilesets: Map<string, RasterTilesetDescriptor>): MultiRasterTilesetDescriptor;
/**
 * Strategy for selecting a secondary tileset level.
 *
 * - `"closest"` — Pick the level whose `metersPerPixel` is nearest to the
 *   primary's, in either direction. Minimizes wasted bandwidth but may return
 *   a slightly coarser level than necessary.
 * - `"closest-finer"` — Prefer the finest level whose `metersPerPixel` is
 *   <= the primary's. Falls back to the finest available if all levels are
 *   coarser. Ensures the secondary is never blurrier than necessary when a
 *   finer option exists.
 */
export type SecondaryLevelStrategy = "closest" | "closest-finer";
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
export declare function selectSecondaryLevel(levels: RasterTilesetLevel[], primaryMetersPerPixel: number, strategy?: SecondaryLevelStrategy): RasterTilesetLevel;
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
export declare function tilesetLevelsEqual(a: RasterTilesetLevel, b: RasterTilesetLevel): boolean;
//# sourceMappingURL=multi-tileset-descriptor.d.ts.map