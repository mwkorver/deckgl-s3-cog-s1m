/**
 * Props for the {@link LinearRescale} shader module.
 */
export type LinearRescaleProps = {
    /** Minimum input value (maps to 0.0 in output). */
    rescaleMin: number;
    /** Maximum input value (maps to 1.0 in output). */
    rescaleMax: number;
};
/**
 * A shader module that linearly rescales RGB color values from
 * `[min, max]` to `[0, 1]`, clamping values outside the range.
 *
 * Useful for normalizing data like Sentinel-2 reflectance (0-10000 stored
 * as uint16) into a visible range after `r16unorm` normalization maps
 * them to approximately 0.0-0.15.
 *
 * @example
 * ```ts
 * // Sentinel-2 L2A: reflectance 0-10000 → r16unorm 0.0-0.153
 * { module: LinearRescale, props: { rescaleMin: 0, rescaleMax: 0.15 } }
 * ```
 */
export declare const LinearRescale: {
    readonly name: "linearRescale";
    readonly fs: "uniform linearRescaleUniforms {\n  float rescaleMin;\n  float rescaleMax;\n} linearRescale;\n";
    readonly inject: {
        readonly "fs:DECKGL_FILTER_COLOR": "\n  color.rgb = clamp((color.rgb - linearRescale.rescaleMin) / (linearRescale.rescaleMax - linearRescale.rescaleMin), 0.0, 1.0);\n";
    };
    readonly uniformTypes: {
        readonly rescaleMin: "f32";
        readonly rescaleMax: "f32";
    };
    readonly getUniforms: (props: Partial<LinearRescaleProps>) => {
        rescaleMin: number;
        rescaleMax: number;
    };
};
//# sourceMappingURL=linear-rescale.d.ts.map