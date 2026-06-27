/**
 * A {@link RasterTilesetDescriptor} backed by per-level affine transforms.
 *
 * Derives `projectedBounds` from the coarsest level's array. Everything else
 * is passed through from the constructor options.
 */
export class AffineTileset {
    levels;
    projectTo3857;
    projectFrom3857;
    projectTo4326;
    projectFrom4326;
    projectedBounds;
    constructor(options) {
        if (options.levels.length === 0) {
            throw new Error("AffineTileset requires at least one level");
        }
        this.levels = options.levels;
        this.projectTo3857 = options.projectTo3857;
        this.projectFrom3857 = options.projectFrom3857;
        this.projectTo4326 = options.projectTo4326;
        this.projectFrom4326 = options.projectFrom4326;
        this.projectedBounds = options.levels[0].projectedBounds;
    }
}
//# sourceMappingURL=affine-tileset.js.map