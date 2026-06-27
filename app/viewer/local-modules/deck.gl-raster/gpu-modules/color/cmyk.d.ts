/**
 * A shader module that converts CMYK input (RGBA channels read as C, M, Y,
 * K) to RGB. For TIFFs with `PhotometricInterpretation = 5` (Separated /
 * CMYK).
 */
export declare const CMYKToRGB: {
    readonly name: "cmyk-to-rgb";
    readonly inject: {
        readonly "fs:#decl": "\n  vec3 cmykToRgb(vec4 cmyk) {\n    // cmyk in [0.0, 1.0]\n    float invK = 1.0 - cmyk.a;\n\n    return vec3(\n        (1.0 - cmyk.r) * invK,\n        (1.0 - cmyk.g) * invK,\n        (1.0 - cmyk.b) * invK\n    );\n  }\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      color.rgb = cmykToRgb(color);\n    ";
    };
};
//# sourceMappingURL=cmyk.d.ts.map