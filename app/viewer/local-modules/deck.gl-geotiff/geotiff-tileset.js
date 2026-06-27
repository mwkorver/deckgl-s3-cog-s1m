import { AffineTileset, AffineTilesetLevel, } from "@s3-cog/deck.gl-raster";
/**
 * Build an {@link AffineTileset} {@link TilesetDescriptor} from a {@link GeoTIFF}.
 *
 * Produces one {@link AffineTilesetLevel} per overview plus a final entry for
 * the full-resolution image. Levels are emitted coarsest first.
 *
 * Replaces the previous `generateTileMatrixSet` + `TileMatrixSetAdaptor`
 * pipeline. Because {@link AffineTilesetLevel} is parameterized by an
 * arbitrary affine, this works correctly for COGs with rotated, skewed, or
 * non-square-pixel geotransforms.
 *
 * @param geotiff  The opened GeoTIFF.
 * @param opts     Projection functions and meters-per-CRS-unit.
 */
export function geoTiffToDescriptor(geotiff, opts) {
    // GeoTIFF.overviews is sorted finest-to-coarsest. Reverse for coarsest-first
    // and append the full-resolution image as the finest level.
    const images = [
        ...[...geotiff.overviews].reverse(),
        geotiff,
    ];
    const levels = images.map((img) => new AffineTilesetLevel({
        affine: img.transform,
        arrayWidth: img.width,
        arrayHeight: img.height,
        tileWidth: img.tileWidth,
        tileHeight: img.tileHeight,
        mpu: opts.mpu,
    }));
    return new AffineTileset({
        levels,
        projectTo3857: opts.projectTo3857,
        projectFrom3857: opts.projectFrom3857,
        projectTo4326: opts.projectTo4326,
        projectFrom4326: opts.projectFrom4326,
    });
}
//# sourceMappingURL=geotiff-tileset.js.map