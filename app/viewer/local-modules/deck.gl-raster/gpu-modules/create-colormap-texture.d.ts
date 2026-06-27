import type { Device, Texture } from "@luma.gl/core";
/**
 * Upload a decoded colormap sprite to the GPU as a 2D array texture.
 *
 * The image must be exactly 256 pixels wide; each row becomes one layer
 * of the returned `Texture` (`dimension: "2d-array"`, `format:
 * "rgba8unorm"`). Use the result as the `colormapTexture` prop of the
 * `Colormap` shader module.
 *
 * Synchronous — pair with `decodeColormapSprite` when you have a URL or
 * raw bytes rather than an already-decoded `ImageData`.
 *
 * @throws when `imageData.width` is not 256.
 */
export declare function createColormapTexture(device: Device, imageData: ImageData): Texture;
//# sourceMappingURL=create-colormap-texture.d.ts.map