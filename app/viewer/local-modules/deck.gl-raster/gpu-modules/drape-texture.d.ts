import type { Texture } from "@luma.gl/core";
/** Props for the {@link DrapeTexture} shader module. */
export type DrapeTextureProps = {
    /** RGB imagery texture sampled by mesh UV and multiplied by terrain shade. */
    drapeTexture: Texture;
};
/**
 * Applies an imagery texture over terrain after {@link TerrainDisplace}.
 *
 * TerrainDisplace is configured to output grayscale hillshade in draped mode;
 * this module preserves that shade while replacing the hypsometric colour with
 * the supplied imagery.
 */
export declare const DrapeTexture: {
    readonly name: "drape-texture";
    readonly fs: "uniform sampler2D drapeTexture;";
    readonly inject: {
        readonly "fs:DECKGL_FILTER_COLOR": "\n  {\n    vec4 drape = texture(drapeTexture, geometry.uv);\n    if (drape.a > 0.0) {\n      float shade = clamp(color.a, 0.0, 1.5);\n      color = vec4(drape.rgb * shade, 1.0);\n    }\n  }\n";
    };
    readonly getUniforms: (props?: Partial<DrapeTextureProps>) => {
        drapeTexture: Texture | undefined;
    };
};
//# sourceMappingURL=drape-texture.d.ts.map