import type { AffineTilesetLevel } from "./affine-tileset-level.js";
import type { RasterTilesetDescriptor } from "./tileset-interface.js";
import type { Bounds, ProjectionFunction } from "./types.js";
/**
 * Constructor options for {@link AffineTileset}.
 */
export interface AffineTilesetOptions {
    /** Resolution levels, ordered coarsest first. */
    levels: AffineTilesetLevel[];
    /** Forward projection function from source CRS to EPSG:3857. */
    projectTo3857: ProjectionFunction;
    /** Inverse projection function from EPSG:3857 to source CRS. */
    projectFrom3857: ProjectionFunction;
    /** Forward projection function from source CRS to EPSG:4326. */
    projectTo4326: ProjectionFunction;
    /** Inverse projection function from EPSG:4326 to source CRS. */
    projectFrom4326: ProjectionFunction;
}
/**
 * A {@link RasterTilesetDescriptor} backed by per-level affine transforms.
 *
 * Derives `projectedBounds` from the coarsest level's array. Everything else
 * is passed through from the constructor options.
 */
export declare class AffineTileset implements RasterTilesetDescriptor {
    readonly levels: AffineTilesetLevel[];
    readonly projectTo3857: ProjectionFunction;
    readonly projectFrom3857: ProjectionFunction;
    readonly projectTo4326: ProjectionFunction;
    readonly projectFrom4326: ProjectionFunction;
    readonly projectedBounds: Bounds;
    constructor(options: AffineTilesetOptions);
}
//# sourceMappingURL=affine-tileset.d.ts.map