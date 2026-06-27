/**
 * A shader module that converts YCbCr input (RGB channels read as Y, Cb,
 * Cr) to RGB using the JFIF / JPEG conversion. For TIFFs with
 * `PhotometricInterpretation = 6` (YCbCr) where the decoder has not
 * already converted to RGB.
 */
export declare const YCbCrToRGB: {
    readonly name: "ycbcr-to-rgb";
    readonly inject: {
        readonly "fs:#decl": "\n  vec3 ycbcrToRgb(vec3 ycbcr) {\n    // ycbcr in [0.0, 1.0]\n    float y = ycbcr.r;\n    float cb = ycbcr.g - 0.5;\n    float cr = ycbcr.b - 0.5;\n\n    return vec3(\n        y + 1.40200 * cr,\n        y - 0.34414 * cb - 0.71414 * cr,\n        y + 1.77200 * cb\n    );\n  }\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      color.rgb = ycbcrToRgb(color.rgb);\n    ";
    };
};
//# sourceMappingURL=ycbcr.d.ts.map