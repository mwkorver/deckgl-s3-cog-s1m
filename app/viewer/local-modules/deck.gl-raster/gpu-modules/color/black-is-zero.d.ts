/**
 * A shader module that converts single-band grayscale data to RGB by
 * broadcasting the input value (0 = black, 1 = white) into all three
 * channels. Matches TIFF `PhotometricInterpretation = 1` (BlackIsZero).
 */
export declare const BlackIsZero: {
    readonly name: "black-is-zero";
    readonly inject: {
        readonly "fs:#decl": "\n  vec3 black_zero_to_rgb(float value) {\n    return vec3(value, value, value);\n  }\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      color.rgb = black_zero_to_rgb(color.r);\n    ";
    };
};
//# sourceMappingURL=black-is-zero.d.ts.map