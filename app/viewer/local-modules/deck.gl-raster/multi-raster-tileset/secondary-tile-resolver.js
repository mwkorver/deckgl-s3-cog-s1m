/**
 * Resolve which secondary tiles cover a primary tile's extent, and compute
 * the UV transform to map from primary UV space into the stitched secondary
 * texture.
 *
 * The UV transform `[offsetX, offsetY, scaleX, scaleY]` is intended for use
 * in a shader as `sampledUV = uv * scale + offset`, where `uv` is the
 * primary tile's local UV coordinate in [0,1]^2.
 *
 * The Y axis follows a top-left convention: origin is at the top-left corner,
 * Y increases downward in texture/UV space. CRS coordinates may increase
 * upward (north), so `offsetY` is computed as
 * `(stitchedMaxY - primaryMaxY) / stitchedCrsHeight` to account for the flip.
 *
 * @param primaryLevel - The {@link RasterTilesetLevel} describing the primary tileset.
 * @param primaryCol - Column index of the primary tile.
 * @param primaryRow - Row index of the primary tile.
 * @param secondaryLevel - The {@link RasterTilesetLevel} describing the secondary tileset.
 * @param secondaryZ - The zoom level index of `secondaryLevel` within its
 *   {@link TilesetDescriptor.levels} array. Stored in the returned
 *   {@link SecondaryTileResolution.z} so the consumer knows which COG overview
 *   to fetch.
 * @returns A {@link SecondaryTileResolution} with tile indices, UV transform,
 *   stitched dimensions, and the min col/row of the covered range.
 */
export function resolveSecondaryTiles(primaryLevel, primaryCol, primaryRow, secondaryLevel, secondaryZ) {
    // Step 1: Get the CRS extent of the primary tile
    const corners = primaryLevel.projectedTileCorners(primaryCol, primaryRow);
    const primaryMinX = Math.min(corners.topLeft[0], corners.bottomLeft[0], corners.topRight[0], corners.bottomRight[0]);
    const primaryMaxX = Math.max(corners.topLeft[0], corners.bottomLeft[0], corners.topRight[0], corners.bottomRight[0]);
    const primaryMinY = Math.min(corners.topLeft[1], corners.bottomLeft[1], corners.topRight[1], corners.bottomRight[1]);
    const primaryMaxY = Math.max(corners.topLeft[1], corners.bottomLeft[1], corners.topRight[1], corners.bottomRight[1]);
    // Step 2: Find covering secondary tiles
    const range = secondaryLevel.crsBoundsToTileRange(primaryMinX, primaryMinY, primaryMaxX, primaryMaxY);
    const tileIndices = [];
    for (let row = range.minRow; row <= range.maxRow; row++) {
        for (let col = range.minCol; col <= range.maxCol; col++) {
            tileIndices.push({ x: col, y: row });
        }
    }
    // Step 3: Compute the CRS extent of the stitched secondary region
    const minCorners = secondaryLevel.projectedTileCorners(range.minCol, range.minRow);
    const maxCorners = secondaryLevel.projectedTileCorners(range.maxCol, range.maxRow);
    const allCornerPoints = [
        minCorners.topLeft,
        minCorners.topRight,
        minCorners.bottomLeft,
        minCorners.bottomRight,
        maxCorners.topLeft,
        maxCorners.topRight,
        maxCorners.bottomLeft,
        maxCorners.bottomRight,
    ];
    const stitchedMinX = Math.min(...allCornerPoints.map((p) => p[0]));
    const stitchedMaxX = Math.max(...allCornerPoints.map((p) => p[0]));
    const stitchedMinY = Math.min(...allCornerPoints.map((p) => p[1]));
    const stitchedMaxY = Math.max(...allCornerPoints.map((p) => p[1]));
    const stitchedCrsWidth = stitchedMaxX - stitchedMinX;
    const stitchedCrsHeight = stitchedMaxY - stitchedMinY;
    // Step 4: Compute UV transform.
    // offsetX: how far the primary tile's left edge is from the stitched left edge.
    // offsetY: how far the primary tile's top edge is from the stitched top edge.
    //   CRS Y increases upward, but UV Y increases downward, so we use
    //   (stitchedMaxY - primaryMaxY) for the top-edge offset.
    const primaryCrsWidth = primaryMaxX - primaryMinX;
    const primaryCrsHeight = primaryMaxY - primaryMinY;
    const scaleX = stitchedCrsWidth > 0 ? primaryCrsWidth / stitchedCrsWidth : 1;
    const scaleY = stitchedCrsHeight > 0 ? primaryCrsHeight / stitchedCrsHeight : 1;
    const offsetX = stitchedCrsWidth > 0 ? (primaryMinX - stitchedMinX) / stitchedCrsWidth : 0;
    const offsetY = stitchedCrsHeight > 0
        ? (stitchedMaxY - primaryMaxY) / stitchedCrsHeight
        : 0;
    // Step 5: Stitched pixel dimensions
    const numCols = range.maxCol - range.minCol + 1;
    const numRows = range.maxRow - range.minRow + 1;
    const stitchedWidth = numCols * secondaryLevel.tileWidth;
    const stitchedHeight = numRows * secondaryLevel.tileHeight;
    return {
        tileIndices,
        uvTransform: [offsetX, offsetY, scaleX, scaleY],
        stitchedWidth,
        stitchedHeight,
        minCol: range.minCol,
        minRow: range.minRow,
        z: secondaryZ,
    };
}
//# sourceMappingURL=secondary-tile-resolver.js.map