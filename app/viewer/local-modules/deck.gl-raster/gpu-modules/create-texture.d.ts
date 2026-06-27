import type { Texture } from "@luma.gl/core";
/** Props for the {@link CreateTexture} shader module. */
export type CreateTextureProps = {
    /** The input image texture to sample. */
    textureName: Texture;
};
/**
 * The base shader module for a render pipeline: samples a single input
 * texture into `color` so subsequent modules can transform it. Use this
 * when no decoding step (e.g. {@link CompositeBands}) is needed.
 */
export declare const CreateTexture: {
    readonly name: "create-texture-unorm";
    readonly inject: {
        readonly "fs:#decl": "uniform sampler2D textureName;";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      color = texture(textureName, geometry.uv);\n    ";
    };
    readonly getUniforms: (props: Partial<CreateTextureProps>) => {
        textureName: Texture | undefined;
    };
};
//# sourceMappingURL=create-texture.d.ts.map