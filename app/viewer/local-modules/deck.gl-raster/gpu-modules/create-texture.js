/**
 * The base shader module for a render pipeline: samples a single input
 * texture into `color` so subsequent modules can transform it. Use this
 * when no decoding step (e.g. {@link CompositeBands}) is needed.
 */
export const CreateTexture = {
    name: "create-texture-unorm",
    inject: {
        "fs:#decl": `uniform sampler2D textureName;`,
        "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color = texture(textureName, geometry.uv);
    `,
    },
    getUniforms: (props) => {
        return {
            textureName: props.textureName,
        };
    },
};
//# sourceMappingURL=create-texture.js.map