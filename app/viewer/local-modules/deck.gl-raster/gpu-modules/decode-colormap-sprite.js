/**
 * Decode a colormap sprite image into `ImageData`. Does not require a GPU
 * `Device`, so it can run during app startup in parallel with the
 * device-creation path; pair with `createColormapTexture` once the device
 * is available.
 *
 * Supported source forms:
 * - `ArrayBuffer` / `Uint8Array`: wrapped in a `Blob` and decoded via
 *   `createImageBitmap`.
 * - `ImageBitmap`: drawn into an `OffscreenCanvas` to extract pixels.
 *
 * To decode from a URL, fetch the bytes first:
 *
 * ```ts
 * const bytes = await (await fetch(colormapsUrl)).arrayBuffer();
 * const imageData = await decodeColormapSprite(bytes);
 * ```
 *
 * Avoiding a `string` overload here keeps the helper from having to
 * disambiguate URL / base64 / data-URL inputs.
 */
export async function decodeColormapSprite(source) {
    const bitmap = await sourceToImageBitmap(source);
    try {
        return bitmapToImageData(bitmap);
    }
    finally {
        bitmap.close();
    }
}
async function sourceToImageBitmap(source) {
    if (source instanceof ImageBitmap) {
        return source;
    }
    // `BlobPart` is strict about `Uint8Array<ArrayBufferLike>` vs
    // `Uint8Array<ArrayBuffer>` in TS 5+. At runtime both an `ArrayBuffer`
    // and any `Uint8Array` are valid blob inputs; the cast sidesteps the
    // overly-narrow typing.
    const blob = new Blob([source]);
    return createImageBitmap(blob);
}
function bitmapToImageData(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Failed to obtain 2D context for decoding the colormap sprite.");
    }
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}
//# sourceMappingURL=decode-colormap-sprite.js.map