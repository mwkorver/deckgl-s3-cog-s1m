import type { ProjectionFunction } from "@s3-cog/deck.gl-raster";
import { AffineTileset } from "@s3-cog/deck.gl-raster";
import type { GeoTIFF } from "@s3-cog/geotiff";
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
export declare function geoTiffToDescriptor(geotiff: GeoTIFF, opts: {
    projectTo3857: ProjectionFunction;
    projectFrom3857: ProjectionFunction;
    projectTo4326: ProjectionFunction;
    projectFrom4326: ProjectionFunction;
    mpu: number;
}): AffineTileset;
//# sourceMappingURL=geotiff-tileset.d.ts.map