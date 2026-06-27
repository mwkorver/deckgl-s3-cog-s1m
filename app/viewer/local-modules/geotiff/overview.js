import { compose, scale } from "@s3-cog/affine";
import { fetchTile, fetchTiles } from "./fetch.js";
import { index, xy } from "./transform.js";
/**
 * A single resolution level of a GeoTIFF — either the full-resolution image
 * or a reduced-resolution overview.  Pairs the data IFD with its
 * corresponding mask IFD (if any).
 */
export class Overview {
    cachedTags;
    /** The data source used for fetching tile data. */
    dataSource;
    /** A reference to the parent GeoTIFF object. */
    geotiff;
    /** The GeoKeyDirectory of the primary IFD. */
    gkd;
    /** The data IFD for this resolution level. */
    image;
    /** The IFD for the mask associated with this overview level, if any. */
    maskImage = null;
    constructor(geotiff, gkd, image, maskImage, cachedTags, dataSource) {
        this.geotiff = geotiff;
        this.gkd = gkd;
        this.image = image;
        this.maskImage = maskImage;
        this.cachedTags = cachedTags;
        this.dataSource = dataSource;
    }
    /**
     * The CRS parsed from the GeoKeyDirectory.
     *
     * Returns an EPSG code (number) for EPSG-coded CRSes, or a PROJJSON object
     * for user-defined CRSes. The result is cached after the first access.
     *
     * See also {@link GeoTIFF.epsg} for the EPSG code directly from the TIFF tags.
     */
    get crs() {
        return this.geotiff.crs;
    }
    /** Image height in pixels. */
    get height() {
        return this.image.size.height;
    }
    /** The no data value, or null if not set. */
    get nodata() {
        return this.geotiff.nodata;
    }
    /** Inherits the {@link GeoTIFF._debug} flag from the parent. */
    get _debug() {
        return this.geotiff._debug;
    }
    /** The number of tiles in the x and y directions */
    get tileCount() {
        return this.image.tileCount;
    }
    /** Tile height in pixels. */
    get tileHeight() {
        return this.image.tileSize.height;
    }
    /** Tile width in pixels. */
    get tileWidth() {
        return this.image.tileSize.width;
    }
    /**
     * Return the dataset's georeferencing transformation matrix.
     */
    get transform() {
        const fullTransform = this.geotiff.transform;
        const scaleX = this.geotiff.width / this.width;
        const scaleY = this.geotiff.height / this.height;
        return compose(fullTransform, scale(scaleX, scaleY));
    }
    /** Image width in pixels. */
    get width() {
        return this.image.size.width;
    }
    /** Fetch a single tile from the full-resolution image.
     *
     * @param x The tile column index (0-based).
     * @param y The tile row index (0-based).
     * @param options Optional parameters for fetching the tile.
     * @param options.boundless Whether to clip tiles that are partially outside the image bounds. When `true`, no clipping is applied and edge tiles are returned at the full nominal tile size. Defaults to `true`.
     * @param options.pool An optional {@link DecoderPool} for decoding the tile data. If not provided, a new decoder will be created for each tile.
     * @param options.signal An optional {@link AbortSignal} to cancel the fetch request.
     */
    async fetchTile(x, y, options = {}) {
        return await fetchTile(this, x, y, options);
    }
    /**
     * Fetch multiple tiles in parallel.
     *
     * A future implementation may coalesce contiguous byte ranges to reduce
     * the number of HTTP requests.
     *
     * @param xy - Array of `[x, y]` tile coordinates.
     * @param options - Optional parameters (same as {@link fetchTile}).
     * @returns Array of {@link Tile} objects in the same order as `xy`.
     *
     * @see {@link fetchTile} for single-tile fetching.
     */
    async fetchTiles(xy, options = {}) {
        return await fetchTiles(this, xy, options);
    }
    // TiledMixin
    // Transform mixin
    /**
     * Get the (row, col) pixel index containing the geographic coordinate (x, y).
     *
     * @param x          x coordinate in the CRS.
     * @param y          y coordinate in the CRS.
     * @param op         Rounding function applied to fractional pixel indices.
     *                   Defaults to Math.floor.
     * @returns          [row, col] pixel indices.
     */
    index(x, y, op = Math.floor) {
        return index(this, x, y, op);
    }
    /**
     * Get the geographic (x, y) coordinate of the pixel at (row, col).
     *
     * @param row        Pixel row.
     * @param col        Pixel column.
     * @param offset     Which part of the pixel to return.  Defaults to "center".
     * @returns          [x, y] in the CRS.
     */
    xy(row, col, offset = "center") {
        return xy(this, row, col, offset);
    }
}
//# sourceMappingURL=overview.js.map