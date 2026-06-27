/**
 * Parse the GeoTIFF `ColorMap` tag into an ImageData.
 *
 * @param cmap  The colormap array from the GeoTIFF `ColorMap` tag.
 * @param nodata  Optional index of the nodata value in the colormap.
 *
 * @return The parsed colormap as an ImageData object.
 */
export declare function parseColormap(cmap: Uint16Array, nodata?: number): ImageData;
//# sourceMappingURL=colormap.d.ts.map