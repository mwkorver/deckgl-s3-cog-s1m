import type { Texture } from "@luma.gl/core";
/** Props for the {@link Colormap} shader module. */
export type ColormapProps = {
    /**
     * The colormap sprite as a 2D array texture. Each layer of the array is
     * one 256×1 RGBA8 colormap. Build from the shipped `colormaps.png` with
     * `decodeColormapSprite` + `createColormapTexture`, or bring your own.
     *
     * Note this must be a Texture2DArray, not a Texture2D.
     */
    colormapTexture: Texture;
    /**
     * Which layer of `colormapTexture` to sample. Pass values from the
     * generated `COLORMAP_INDEX` for the shipped sprite, or any valid layer
     * index for a custom sprite. Defaults to `0`.
     */
    colormapIndex?: number;
    /**
     * When true, samples the colormap in reverse — equivalent to matplotlib's
     * `_r` suffix (e.g. `viridis_r`). Defaults to false.
     */
    reversed?: boolean;
};
/**
 * A shader module that injects a 2D-array colormap texture and samples one
 * layer per fragment, indexed by `colormapIndex`.
 */
export declare const Colormap: {
    readonly name: "colormap";
    readonly fs: "uniform colormapUniforms {\n  int colormapIndex;\n  float reversed;\n} colormap;\n";
    readonly inject: {
        readonly "fs:#decl": "precision highp sampler2DArray;\nuniform sampler2DArray colormapTexture;\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      float idx = mix(color.r, 1.0 - color.r, colormap.reversed);\n      color = texture(\n        colormapTexture,\n        vec3(idx, 0.5, float(colormap.colormapIndex))\n      );\n    ";
    };
    readonly uniformTypes: {
        readonly colormapIndex: "i32";
        readonly reversed: "f32";
    };
    readonly getUniforms: (props: Partial<ColormapProps>) => {
        colormapTexture: Texture | undefined;
        colormapIndex: number;
        reversed: boolean;
    };
};
//# sourceMappingURL=colormap.d.ts.map