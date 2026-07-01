// Utilities for interacting with a GeoTIFF

import type {
  ConcurrencyLimiter,
  Priority,
  RasterArray,
  RasterArrayPixelInterleaved,
} from "@s3-cog/geotiff";
import { GeoTIFF } from "@s3-cog/geotiff";
import type { Converter } from "proj4";

/**
 * Add an alpha channel to an RGB image array.
 *
 * Only supports input arrays with 3 (RGB) or 4 (RGBA) channels. If the input is
 * already RGBA, it is returned unchanged.
 */
/**
 * Interleave a band-separate image array into a contiguous pixel-interleaved array.
 */
export function interleaveBands(image: RasterArray): RasterArrayPixelInterleaved {
  if (image.layout !== "band-separate") {
    return image as RasterArrayPixelInterleaved;
  }
  const { width, height, bands } = image;
  if (!bands || bands.length === 0) {
    throw new Error("Band-separate image has no bands.");
  }
  const numBands = bands.length;
  const numPixels = width * height;
  const firstBand = bands[0];

  let interleavedData: any;
  if (firstBand instanceof Uint16Array) {
    interleavedData = new Uint16Array(numPixels * numBands);
  } else if (firstBand instanceof Int16Array) {
    interleavedData = new Int16Array(numPixels * numBands);
  } else if (firstBand instanceof Float32Array) {
    interleavedData = new Float32Array(numPixels * numBands);
  } else if (firstBand instanceof Uint8ClampedArray) {
    interleavedData = new Uint8ClampedArray(numPixels * numBands);
  } else {
    interleavedData = new Uint8Array(numPixels * numBands);
  }

  for (let i = 0; i < numPixels; ++i) {
    for (let j = 0; j < numBands; ++j) {
      interleavedData[i * numBands + j] = bands[j]![i];
    }
  }

  return {
    ...image,
    layout: "pixel-interleaved" as any,
    data: interleavedData,
  } as RasterArrayPixelInterleaved;
}

export function addAlphaChannel(rgbImage: RasterArray): RasterArray {
  let img: RasterArrayPixelInterleaved;
  if (rgbImage.layout === "band-separate") {
    img = interleaveBands(rgbImage);
  } else {
    img = rgbImage as RasterArrayPixelInterleaved;
  }

  const { height, width } = img;

  if (img.data.length === height * width * 4) {
    // Already has alpha channel
    return img;
  } else if (img.data.length === height * width * 3) {
    // Need to add alpha channel

    const rgbaLength = (img.data.length / 3) * 4;
    const isUint16 = img.data instanceof Uint16Array;
    const rgbaArray = isUint16
      ? new Uint16Array(rgbaLength)
      : new Uint8ClampedArray(rgbaLength);
    const maxAlpha = isUint16 ? 65535 : 255;
    for (let i = 0; i < img.data.length / 3; ++i) {
      rgbaArray[i * 4] = img.data[i * 3]!;
      rgbaArray[i * 4 + 1] = img.data[i * 3 + 1]!;
      rgbaArray[i * 4 + 2] = img.data[i * 3 + 2]!;
      rgbaArray[i * 4 + 3] = maxAlpha;
    }

    return {
      ...img,
      count: 4,
      data: rgbaArray,
    };
  } else {
    throw new Error(
      `Unexpected number of channels in raster data: ${img.data.length / (height * width)}`,
    );
  }
}

export async function fetchGeoTIFF(
  input: GeoTIFF | string | URL | ArrayBuffer,
  options: {
    headers?: Record<string, string>;
    concurrencyLimiter?: ConcurrencyLimiter | null;
    getPriority?: () => Priority;
    signal?: AbortSignal;
  } = {},
): Promise<GeoTIFF> {
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
export function getGeographicBounds(
  geotiff: GeoTIFF,
  converter: Converter,
): { west: number; south: number; east: number; north: number } {
  const [minX, minY, maxX, maxY] = geotiff.bbox;

  // Reproject all four corners to handle rotation/skew
  const corners: [number, number][] = [
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
