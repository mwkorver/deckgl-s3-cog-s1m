// Utilities for interacting with a GeoTIFF
import { GeoTIFF } from "@s3-cog/geotiff";
/**
 * Add an alpha channel to an RGB image array.
 *
 * Only supports input arrays with 3 (RGB) or 4 (RGBA) channels. If the input is
 * already RGBA, it is returned unchanged.
 */
export function addAlphaChannel(rgbImage) {
    const { height, width } = rgbImage;
    if (rgbImage.layout === "band-separate") {
        // This should be pretty easy to do by just returning an additional array of
        // 255s
        // But not sure if we'll want to do that, because it's fine to upload 3
        // separate textures.
        throw new Error("Band-separate images not yet implemented.");
    }
    if (rgbImage.data.length === height * width * 4) {
        // Already has alpha channel
        return rgbImage;
    }
    else if (rgbImage.data.length === height * width * 3) {
        // Need to add alpha channel
        const rgbaLength = (rgbImage.data.length / 3) * 4;
        const isUint16 = rgbImage.data instanceof Uint16Array;
        const rgbaArray = isUint16
            ? new Uint16Array(rgbaLength)
            : new Uint8ClampedArray(rgbaLength);
        const maxAlpha = isUint16 ? 65535 : 255;
        for (let i = 0; i < rgbImage.data.length / 3; ++i) {
            rgbaArray[i * 4] = rgbImage.data[i * 3];
            rgbaArray[i * 4 + 1] = rgbImage.data[i * 3 + 1];
            rgbaArray[i * 4 + 2] = rgbImage.data[i * 3 + 2];
            rgbaArray[i * 4 + 3] = maxAlpha;
        }
        return {
            ...rgbImage,
            count: 4,
            data: rgbaArray,
        };
    }
    else {
        throw new Error(`Unexpected number of channels in raster data: ${rgbImage.data.length / (height * width)}`);
    }
}
export async function fetchGeoTIFF(input, options = {}) {
    if (typeof input === "string" || input instanceof URL) {
        return await GeoTIFF.fromUrl(input, options);
    }
    if (input instanceof ArrayBuffer) {
        return await GeoTIFF.fromArrayBuffer(input);
    }
    return input;
}
/**
 * Calculate the WGS84 bounding box of a GeoTIFF image
 */
export function getGeographicBounds(geotiff, converter) {
    const [minX, minY, maxX, maxY] = geotiff.bbox;
    // Reproject all four corners to handle rotation/skew
    const corners = [
        converter.forward([minX, minY]), // bottom-left
        converter.forward([maxX, minY]), // bottom-right
        converter.forward([maxX, maxY]), // top-right
        converter.forward([minX, maxY]), // top-left
    ];
    // Find the bounding box that encompasses all reprojected corners
    const lons = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const west = Math.min(...lons);
    const south = Math.min(...lats);
    const east = Math.max(...lons);
    const north = Math.max(...lats);
    // Return bounds in MapLibre format: [[west, south], [east, north]]
    return { west, south, east, north };
}
//# sourceMappingURL=geotiff.js.map