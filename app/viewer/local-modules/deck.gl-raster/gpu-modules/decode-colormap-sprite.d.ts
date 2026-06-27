/** Any source that {@link decodeColormapSprite} can normalize into an `ImageData`. */
export type ColormapSpriteSource = ArrayBuffer | Uint8Array | ImageBitmap;
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
export declare function decodeColormapSprite(source: ColormapSpriteSource): Promise<ImageData>;
//# sourceMappingURL=decode-colormap-sprite.d.ts.map