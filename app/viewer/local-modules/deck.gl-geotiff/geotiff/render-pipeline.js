import { Photometric, SampleFormat } from "@cogeotiff/core";
import { BlackIsZero, CMYKToRGB, Colormap, CreateTexture, cieLabToRGB, FilterNoDataVal, MaskTexture, WhiteIsZero, } from "@s3-cog/deck.gl-raster/gpu-modules";
import { parseColormap } from "@s3-cog/geotiff";
import { addAlphaChannel } from "./geotiff.js";
import { inferTextureFormat } from "./texture.js";
export function inferRenderPipeline(geotiff, device) {
    const { sampleFormat } = geotiff.cachedTags;
    if (sampleFormat === null) {
        throw new Error("SampleFormat tag is required to infer render pipeline");
    }
    switch (sampleFormat[0]) {
        // Unsigned integers
        case SampleFormat.Uint:
            return createUnormPipeline(geotiff, device);
    }
    throw new Error(`Inferring render pipeline for non-unsigned integers not yet supported. Found SampleFormat: ${sampleFormat}`);
}
/**
 * Create pipeline for visualizing unsigned-integer data.
 */
function createUnormPipeline(geotiff, device) {
    const { bitsPerSample, colorMap, photometric, sampleFormat, samplesPerPixel, nodata, } = geotiff.cachedTags;
    const renderPipeline = [
        {
            module: CreateTexture,
            props: {
                textureName: (data) => data.texture,
            },
        },
    ];
    if (nodata !== null) {
        // Since values are 0-1 for unorm textures, scale nodata to [0, 1]
        const maxVal = 2 ** bitsPerSample[0] - 1;
        const noDataScaled = nodata / maxVal;
        renderPipeline.push({
            module: FilterNoDataVal,
            props: { value: noDataScaled },
        });
    }
    if (geotiff.maskImage !== null) {
        renderPipeline.push({
            module: MaskTexture,
            props: {
                // TODO: how to handle if mask failed to load and is undefined here
                maskTexture: (data) => data.mask,
            },
        });
    }
    const toRGBModule = photometricInterpretationToRGB({
        count: samplesPerPixel,
        photometric,
        device,
        colorMap,
    });
    if (toRGBModule) {
        renderPipeline.push(toRGBModule);
    }
    // For palette images, use nearest-neighbor sampling, because indices into a
    // colormap can't be interpolated
    const samplerOptions = photometric === Photometric.Palette
        ? {
            magFilter: "nearest",
            minFilter: "nearest",
        }
        : {
            magFilter: "linear",
            minFilter: "linear",
        };
    const getTileData = async (image, options) => {
        const { device, x, y, signal, pool } = options;
        const tile = await image.fetchTile(x, y, {
            boundless: false,
            pool,
            signal,
        });
        let { array } = tile;
        const { width, height, mask } = array;
        let numSamples = samplesPerPixel;
        if (samplesPerPixel === 3) {
            // WebGL2 doesn't have an RGB-only texture format; it requires RGBA.
            array = addAlphaChannel(array);
            numSamples = 4;
        }
        if (array.layout === "band-separate") {
            throw new Error("Band-separate images not yet implemented.");
        }
        const textureFormat = inferTextureFormat(
        // Add one sample for added alpha channel
        numSamples, bitsPerSample, sampleFormat);
        let byteLength = array.data.byteLength;
        const texture = device.createTexture({
            data: array.data,
            format: textureFormat,
            width,
            height,
            sampler: samplerOptions,
        });
        let maskTexture;
        if (mask !== null) {
            maskTexture = device.createTexture({
                data: mask,
                // Single-channel 8-bit texture for the mask
                format: "r8unorm",
                width,
                height,
                // Use nearest filtering for the mask to avoid interpolated edges/halos
                sampler: {
                    minFilter: "nearest",
                    magFilter: "nearest",
                },
            });
            byteLength += mask.byteLength;
        }
        return {
            texture,
            mask: maskTexture,
            byteLength,
            height: array.height,
            width: array.width,
        };
    };
    const renderTile = (tileData) => {
        return {
            renderPipeline: renderPipeline.map((m, _i) => resolveModule(m, tileData)),
        };
    };
    return { getTileData, renderTile };
}
function photometricInterpretationToRGB({ count, colorMap, device, photometric, }) {
    if (count === 3 || count === 4) {
        // Always interpret 3-band or 4-band images as RGB/RGBA
        return null;
    }
    switch (photometric) {
        case Photometric.MinIsWhite: {
            return {
                module: WhiteIsZero,
            };
        }
        case Photometric.MinIsBlack: {
            return {
                module: BlackIsZero,
            };
        }
        case Photometric.Rgb:
            return null;
        case Photometric.Palette: {
            if (!colorMap) {
                throw new Error("ColorMap is required for PhotometricInterpretation Palette");
            }
            const { data, width, height } = parseColormap(colorMap);
            const cmapTexture = device.createTexture({
                dimension: "2d-array",
                data,
                format: "rgba8unorm",
                width,
                height,
                depth: 1,
                mipLevels: 1,
                sampler: {
                    minFilter: "nearest",
                    magFilter: "nearest",
                    addressModeU: "clamp-to-edge",
                    addressModeV: "clamp-to-edge",
                    addressModeW: "clamp-to-edge",
                },
            });
            return {
                module: Colormap,
                props: {
                    colormapTexture: cmapTexture,
                },
            };
        }
        // Not sure why cogeotiff calls this "Separated", but it means CMYK
        case Photometric.Separated:
            return {
                module: CMYKToRGB,
            };
        case Photometric.Ycbcr:
            // @s3-cog/geotiff currently uses canvas to parse JPEG-compressed
            // YCbCr images, which means the YCbCr->RGB conversion is already done by
            // the browser's image decoder
            return null;
        case Photometric.Cielab:
            return {
                module: cieLabToRGB,
            };
        default:
            throw new Error(`Unsupported PhotometricInterpretation ${photometric}`);
    }
}
/**
 * If any prop of any module is a function, replace that prop value with the
 * result of that function
 */
function resolveModule(m, data) {
    const { module, props } = m;
    if (!props) {
        return { module };
    }
    const resolvedProps = {};
    for (const [key, value] of Object.entries(props)) {
        const newValue = typeof value === "function" ? value(data) : value;
        if (newValue !== undefined) {
            resolvedProps[key] = newValue;
        }
    }
    return { module, props: resolvedProps };
}
//# sourceMappingURL=render-pipeline.js.map