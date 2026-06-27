import * as affine from "@s3-cog/affine";
/**
 * A {@link RasterTilesetLevel} described by a single affine transform plus tile and
 * array sizes.
 *
 * This handles axis-aligned, rotated, skewed, and non-square-pixel grids
 * uniformly. Sources that fit this shape (tiled GeoTIFF overviews, GeoZarr
 * multiscales) can construct one of these per resolution level instead of
 * implementing {@link RasterTilesetLevel} manually.
 */
export class AffineTilesetLevel {
    tileWidth;
    tileHeight;
    matrixWidth;
    matrixHeight;
    metersPerPixel;
    /**
     * Source-CRS bounding box of the level's array `[minX, minY, maxX, maxY]`.
     * Computed from the affine applied to the four array corners.
     */
    projectedBounds;
    _affine;
    _invAffine;
    constructor(options) {
        this._affine = options.affine;
        this._invAffine = affine.invert(options.affine);
        this.tileWidth = options.tileWidth;
        this.tileHeight = options.tileHeight;
        this.matrixWidth = Math.ceil(options.arrayWidth / options.tileWidth);
        this.matrixHeight = Math.ceil(options.arrayHeight / options.tileHeight);
        // Geometric mean of the two pixel-edge scales handles non-square pixels.
        const a = affine.a(options.affine);
        const e = affine.e(options.affine);
        this.metersPerPixel = Math.sqrt(Math.abs(a * e)) * options.mpu;
        const corners = [
            affine.apply(options.affine, 0, 0),
            affine.apply(options.affine, options.arrayWidth, 0),
            affine.apply(options.affine, 0, options.arrayHeight),
            affine.apply(options.affine, options.arrayWidth, options.arrayHeight),
        ];
        const xs = corners.map(([x]) => x);
        const ys = corners.map(([, y]) => y);
        this.projectedBounds = [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
        ];
    }
    projectedTileCorners(col, row) {
        const tw = this.tileWidth;
        const th = this.tileHeight;
        const af = this._affine;
        return {
            topLeft: affine.apply(af, col * tw, row * th),
            topRight: affine.apply(af, (col + 1) * tw, row * th),
            bottomLeft: affine.apply(af, col * tw, (row + 1) * th),
            bottomRight: affine.apply(af, (col + 1) * tw, (row + 1) * th),
        };
    }
    tileTransform(col, row) {
        const tileOffset = affine.translation(col * this.tileWidth, row * this.tileHeight);
        const tileAffine = affine.compose(this._affine, tileOffset);
        const invTileAffine = affine.invert(tileAffine);
        return {
            forwardTransform: (x, y) => affine.apply(tileAffine, x, y),
            inverseTransform: (x, y) => affine.apply(invTileAffine, x, y),
        };
    }
    crsBoundsToTileRange(projectedMinX, projectedMinY, projectedMaxX, projectedMaxY) {
        // Map all four CRS corners through the inverse affine to get pixel coords,
        // then take the bbox in pixel space (handles rotation correctly).
        const inv = this._invAffine;
        const pixelCorners = [
            affine.apply(inv, projectedMinX, projectedMinY),
            affine.apply(inv, projectedMaxX, projectedMinY),
            affine.apply(inv, projectedMinX, projectedMaxY),
            affine.apply(inv, projectedMaxX, projectedMaxY),
        ];
        const xs = pixelCorners.map(([px]) => px);
        const ys = pixelCorners.map(([, py]) => py);
        const pixMinX = Math.min(...xs);
        const pixMaxX = Math.max(...xs);
        const pixMinY = Math.min(...ys);
        const pixMaxY = Math.max(...ys);
        const tw = this.tileWidth;
        const th = this.tileHeight;
        const maxColIdx = this.matrixWidth - 1;
        const maxRowIdx = this.matrixHeight - 1;
        // Asymmetric clamping: only clamp minCol/minRow up from below and
        // maxCol/maxRow down from above. If the bbox lies entirely outside the
        // array, this produces an empty range (min > max) so the consumer's
        // `for (i = min; i <= max; i++)` loop does nothing.
        const minCol = Math.max(0, Math.floor(pixMinX / tw));
        const maxCol = Math.min(maxColIdx, Math.floor(pixMaxX / tw));
        const minRow = Math.max(0, Math.floor(pixMinY / th));
        const maxRow = Math.min(maxRowIdx, Math.floor(pixMaxY / th));
        return { minCol, maxCol, minRow, maxRow };
    }
}
//# sourceMappingURL=affine-tileset-level.js.map