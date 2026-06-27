import type { Texture } from "@luma.gl/core";
/** Props for the {@link MaskTexture} shader module. */
export type MaskTextureProps = {
    /** Single-channel mask texture; pixels with value 0 are discarded. */
    maskTexture: Texture;
};
/**
 * A shader module that discards fragments where a separate single-channel
 * mask texture reads zero. Useful for COG / GeoTIFF transparency masks
 * stored as a sibling IFD.
 *
 * Compares directly against 0.0; assumes the mask is sampled with nearest-
 * neighbor filtering so there are no interpolated intermediate values.
 */
export declare const MaskTexture: {
    readonly name: "mask-texture";
    readonly inject: {
        readonly "fs:#decl": "uniform sampler2D maskTexture;";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      float maskValue = texture(maskTexture, geometry.uv).r;\n      if (maskValue == 0.0) {\n        discard;\n      }\n    ";
    };
    readonly getUniforms: (props: Partial<MaskTextureProps>) => {
        maskTexture: Texture | undefined;
    };
};
//# sourceMappingURL=mask-texture.d.ts.map