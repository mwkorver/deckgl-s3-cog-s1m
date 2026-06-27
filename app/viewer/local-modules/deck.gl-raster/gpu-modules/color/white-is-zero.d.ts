/**
 * A shader module that converts single-band grayscale data to RGB by
 * broadcasting the inverted input value (0 = white, 1 = black) into all
 * three channels. Matches TIFF `PhotometricInterpretation = 0` (WhiteIsZero).
 */
export declare const WhiteIsZero: {
    readonly name: "white-is-zero";
    readonly inject: {
        readonly "fs:#decl": "\n  vec3 white_zero_to_rgb(float value) {\n    return vec3(1.0 - value, 1.0 - value, 1.0 - value);\n  }\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      color.rgb = white_zero_to_rgb(color.r);\n    ";
    };
};
//# sourceMappingURL=white-is-zero.d.ts.map