const MODULE_NAME = "colormap";
/**
 * A shader module that injects a 2D-array colormap texture and samples one
 * layer per fragment, indexed by `colormapIndex`.
 */
export const Colormap = {
    name: MODULE_NAME,
    fs: `\
uniform ${MODULE_NAME}Uniforms {
  int colormapIndex;
  float reversed;
} ${MODULE_NAME};
`,
    inject: {
        "fs:#decl": `\
precision highp sampler2DArray;
uniform sampler2DArray colormapTexture;
`,
        "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float idx = mix(color.r, 1.0 - color.r, ${MODULE_NAME}.reversed);
      color = texture(
        colormapTexture,
        vec3(idx, 0.5, float(${MODULE_NAME}.colormapIndex))
      );
    `,
    },
    uniformTypes: {
        colormapIndex: "i32",
        reversed: "f32",
    },
    getUniforms: (props) => {
        return {
            colormapTexture: props.colormapTexture,
            colormapIndex: props.colormapIndex ?? 0,
            reversed: props.reversed ?? false,
        };
    },
};
//# sourceMappingURL=colormap.js.map