/**
 * Applies an imagery texture over terrain after {@link TerrainDisplace}.
 *
 * TerrainDisplace is configured to output grayscale hillshade in draped mode;
 * this module preserves that shade while replacing the hypsometric colour with
 * the supplied imagery.
 */
export const DrapeTexture = {
    name: "drape-texture",
    fs: /* glsl */ `uniform sampler2D drapeTexture;`,
    inject: {
        "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    vec4 drape = texture(drapeTexture, geometry.uv);
    if (drape.a > 0.0) {
      float shade = clamp(color.a, 0.0, 1.5);
      color = vec4(drape.rgb * shade, 1.0);
    }
  }
`,
    },
    getUniforms: (props = {}) => ({
        drapeTexture: props.drapeTexture,
    }),
};
//# sourceMappingURL=drape-texture.js.map