import type { Affine } from "@s3-cog/affine";
import type { RasterTilesetLevel } from "./tileset-interface.js";
import type { Bounds, Corners, ProjectionFunction } from "./types.js";
/**
 * Constructor options for {@link AffineTilesetLevel}.
 */
export interface AffineTilesetLevelOptions {
    /** Pixel → CRS affine transform for this resolution level. */
    affine: Affine;
    /** Full level width, in pixels. */
    arrayWidth: number;
    /** Full level height, in pixels. */
    arrayHeight: number;
    /** Tile width, in pixels. */
    tileWidth: number;
    /** Tile height, in pixels. */
    tileHeight: number;
    /** Meters per CRS unit (1 for metric CRSes, ≈111000 for WGS84). */
    mpu: number;
}
/**
 * A {@link RasterTilesetLevel} described by a single affine transform plus tile and
 * array sizes.
 *
 * This handles axis-aligned, rotated, skewed, and non-square-pixel grids
 * uniformly. Sources that fit this shape (tiled GeoTIFF overviews, GeoZarr
 * multiscales) can construct one of these per resolution level instead of
 * implementing {@link RasterTilesetLevel} manually.
 */
export declare class AffineTilesetLevel implements RasterTilesetLevel {
    readonly tileWidth: number;
    readonly tileHeight: number;
    readonly matrixWidth: number;
    readonly matrixHeight: number;
    readonly metersPerPixel: number;
    /**
     * Source-CRS bounding box of the level's array `[minX, minY, maxX, maxY]`.
     * Computed from the affine applied to the four array corners.
     */
    readonly projectedBounds: Bounds;
    private readonly _affine;
    private readonly _invAffine;
    constructor(options: AffineTilesetLevelOptions);
    projectedTileCorners(col: number, row: number): Corners;
    tileTransform(col: number, row: number): {
        forwardTransform: ProjectionFunction;
        inverseTransform: ProjectionFunction;
    };
    crsBoundsToTileRange(projectedMinX: number, projectedMinY: number, projectedMaxX: number, projectedMaxY: number): {
        minCol: number;
        maxCol: number;
        minRow: number;
        maxRow: number;
    };
}
//# sourceMappingURL=affine-tileset-level.d.ts.map