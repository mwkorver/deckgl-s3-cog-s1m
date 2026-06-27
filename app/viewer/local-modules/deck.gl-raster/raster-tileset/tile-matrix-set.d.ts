import type { TileMatrixSet } from "@s3-cog/morecantile";
import type { RasterTilesetDescriptor, RasterTilesetLevel } from "./tileset-interface.js";
import type { Bounds, ProjectionFunction } from "./types.js";
/**
 * An adapter interface to use a TileMatrixSet as a RasterTilesetDescriptor for raster
 * tile traversal.
 */
export declare class TileMatrixSetAdaptor implements RasterTilesetDescriptor {
    tms: TileMatrixSet;
    private _levels;
    projectTo3857: ProjectionFunction;
    projectFrom3857: ProjectionFunction;
    projectTo4326: ProjectionFunction;
    projectFrom4326: ProjectionFunction;
    constructor(tms: TileMatrixSet, { projectTo3857, projectFrom3857, projectTo4326, projectFrom4326, }: {
        projectTo3857: ProjectionFunction;
        projectFrom3857: ProjectionFunction;
        projectTo4326: ProjectionFunction;
        projectFrom4326: ProjectionFunction;
    });
    get levels(): RasterTilesetLevel[];
    get projectedBounds(): Bounds;
}
//# sourceMappingURL=tile-matrix-set.d.ts.map