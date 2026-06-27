import type { RenderTileResult } from "@s3-cog/deck.gl-raster";
import type { GeoTIFF, Overview } from "@s3-cog/geotiff";
import type { Device, Texture } from "@luma.gl/core";
import type { GetTileDataOptions } from "../cog-layer.js";
export type TextureDataT = {
    height: number;
    width: number;
    byteLength: number;
    texture: Texture;
    mask?: Texture;
};
export declare function inferRenderPipeline(geotiff: GeoTIFF, device: Device): {
    getTileData: (image: GeoTIFF | Overview, options: GetTileDataOptions) => Promise<TextureDataT>;
    renderTile: (data: TextureDataT) => RenderTileResult;
};
//# sourceMappingURL=render-pipeline.d.ts.map