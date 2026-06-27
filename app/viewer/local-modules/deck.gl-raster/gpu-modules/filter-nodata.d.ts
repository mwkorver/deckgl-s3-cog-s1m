/** Props for the {@link FilterNoDataVal} shader module. */
export type FilterNoDataValProps = {
    /**
     * The sentinel nodata value, in the same units as `color.r` after any
     * earlier pipeline modules. Pixels whose red channel exactly equals
     * this value are discarded.
     */
    value: number;
};
/**
 * A shader module that filters out (discards) pixels whose value matches the
 * provided nodata value.
 */
export declare const FilterNoDataVal: {
    readonly name: "nodata";
    readonly fs: "uniform nodataUniforms {\n  float value;\n} nodata;\n";
    readonly inject: {
        readonly "fs:DECKGL_FILTER_COLOR": "\n    if (color.r == nodata.value) {\n      discard;\n    }\n    ";
    };
    readonly uniformTypes: {
        readonly value: "f32";
    };
    readonly getUniforms: (props: Partial<FilterNoDataValProps>) => {
        value: number | undefined;
    };
};
//# sourceMappingURL=filter-nodata.d.ts.map