/**
 * A shader module that discards fragments where a separate single-channel
 * mask texture reads zero. Useful for COG / GeoTIFF transparency masks
 * stored as a sibling IFD.
 *
 * Compares directly against 0.0; assumes the mask is sampled with nearest-
 * neighbor filtering so there are no interpolated intermediate values.
 */
export const MaskTexture = {
    name: "mask-texture",
    inject: {
        "fs:#decl": `uniform sampler2D maskTexture;`,
        "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float maskValue = texture(maskTexture, geometry.uv).r;
      if (maskValue == 0.0) {
        discard;
      }
    `,
    },
    getUniforms: (props) => {
        return {
            maskTexture: props.maskTexture,
        };
    },
};
//# sourceMappingURL=mask-texture.js.map