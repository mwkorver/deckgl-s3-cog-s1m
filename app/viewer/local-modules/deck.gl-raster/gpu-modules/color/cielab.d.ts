/**
 * A shader module that converts CIE L\*a\*b\* input (RGB channels read as L,
 * a, b on a D65 white point) to sRGB. For TIFFs with
 * `PhotometricInterpretation = 8` (CIELab).
 */
export declare const cieLabToRGB: {
    readonly name: "cielab-to-rgb";
    readonly inject: {
        readonly "fs:#decl": "\n  const vec3 D65 = vec3(\n      0.95047, // Xn\n      1.00000, // Yn\n      1.08883 // Zn\n  );\n\n  vec3 cielabToRgb(vec3 labTex) {\n    // labTex in [0,1] from RGB8 texture\n    float L = labTex.r * 255.0;\n    float a = (labTex.g - 0.5) * 255.0;\n    float b = (labTex.b - 0.5) * 255.0;\n\n    float y = (L + 16.0) / 116.0;\n    float x = (a / 500.0) + y;\n    float z = y - (b / 200.0);\n\n    vec3 xyz;\n    vec3 v = vec3(x, y, z);\n    vec3 v3 = v * v * v;\n\n    xyz = D65 * mix(\n      (v - 16.0 / 116.0) / 7.787,\n      v3,\n      step(0.008856, v3)\n    );\n\n    vec3 rgb = mat3(\n      3.2406, -1.5372, -0.4986,\n      -0.9689, 1.8758, 0.0415,\n      0.0557, -0.2040, 1.0570\n    ) * xyz;\n\n    // sRGB gamma\n    rgb = mix(\n      12.92 * rgb,\n      1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055,\n      step(0.0031308, rgb)\n    );\n\n    return clamp(rgb, 0.0, 1.0);\n  }\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n      color.rgb = cielabToRgb(color);\n    ";
    };
};
//# sourceMappingURL=cielab.d.ts.map