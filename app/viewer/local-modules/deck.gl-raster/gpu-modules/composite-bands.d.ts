import type { Texture } from "@luma.gl/core";
import type { UvTransform } from "../multi-raster-tileset/index.js";
/**
 * Maximum number of band texture slots supported by {@link CompositeBands}.
 */
export declare const MAX_BAND_SLOTS = 4;
/**
 * Props for the {@link CompositeBands} shader module.
 *
 * Textures (`band0`–`band3`) are bound via `getUniforms`. Scalar uniforms
 * (`uvTransform0`–`uvTransform3`, `channelMap`) go through a uniform block.
 */
export type CompositeBandsProps = {
    band0: Texture;
    band1: Texture;
    band2: Texture;
    band3: Texture;
    uvTransform0: UvTransform;
    uvTransform1: UvTransform;
    uvTransform2: UvTransform;
    uvTransform3: UvTransform;
    channelMap: [number, number, number, number];
};
/**
 * A shader module that samples up to 4 band textures with per-band UV
 * transforms and composites them into a `vec4` color.
 *
 * Uses fixed uniform slots (`band0`–`band3`) for textures (bound via
 * `getUniforms`) and a uniform block for scalar values (`uvTransform0`–
 * `uvTransform3`, `channelMap`).
 *
 * @see {@link CompositeBandsProps}
 * @see {@link buildCompositeBandsProps} for a helper that maps named bands
 *   to slot indices.
 */
export declare const CompositeBands: {
    readonly name: "compositeBands";
    readonly inject: {
        readonly "fs:#decl": "\nuniform sampler2D band0;\nuniform sampler2D band1;\nuniform sampler2D band2;\nuniform sampler2D band3;\n\nvec2 compositeBands_applyUv(vec2 uv, vec4 transform) {\n  return uv * transform.zw + transform.xy;\n}\n\nfloat compositeBands_sampleSlot(int slot, vec2 uv) {\n  if (slot == 0) return texture(band0, compositeBands_applyUv(uv, compositeBands.uvTransform0)).r;\n  if (slot == 1) return texture(band1, compositeBands_applyUv(uv, compositeBands.uvTransform1)).r;\n  if (slot == 2) return texture(band2, compositeBands_applyUv(uv, compositeBands.uvTransform2)).r;\n  if (slot == 3) return texture(band3, compositeBands_applyUv(uv, compositeBands.uvTransform3)).r;\n  return 0.0;\n}\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n  float r = compositeBands.channelMap.r >= 0 ? compositeBands_sampleSlot(compositeBands.channelMap.r, geometry.uv) : 0.0;\n  float g = compositeBands.channelMap.g >= 0 ? compositeBands_sampleSlot(compositeBands.channelMap.g, geometry.uv) : 0.0;\n  float b = compositeBands.channelMap.b >= 0 ? compositeBands_sampleSlot(compositeBands.channelMap.b, geometry.uv) : 0.0;\n  float a = compositeBands.channelMap.a >= 0 ? compositeBands_sampleSlot(compositeBands.channelMap.a, geometry.uv) : 1.0;\n  color = vec4(r, g, b, a);\n";
    };
    readonly fs: "uniform compositeBandsUniforms {\n  vec4 uvTransform0;\n  vec4 uvTransform1;\n  vec4 uvTransform2;\n  vec4 uvTransform3;\n  ivec4 channelMap;\n} compositeBands;\n";
    readonly uniformTypes: {
        readonly uvTransform0: "vec4<f32>";
        readonly uvTransform1: "vec4<f32>";
        readonly uvTransform2: "vec4<f32>";
        readonly uvTransform3: "vec4<f32>";
        readonly channelMap: "vec4<i32>";
    };
    readonly getUniforms: (props: Partial<CompositeBandsProps>) => {
        band0: Texture | undefined;
        band1: Texture | undefined;
        band2: Texture | undefined;
        band3: Texture | undefined;
        uvTransform0: UvTransform;
        uvTransform1: UvTransform;
        uvTransform2: UvTransform;
        uvTransform3: UvTransform;
        channelMap: [number, number, number, number];
    };
};
/**
 * Maps named bands and their UV transforms to {@link CompositeBandsProps}
 * slot indices.
 *
 * Assigns each unique band name to a fixed slot (0–3), builds the
 * `channelMap` that maps RGBA output channels to slots, and fills unused
 * slots with a placeholder texture to satisfy WebGL binding requirements.
 *
 * @param mapping - Which named band goes to which RGBA channel.
 * @param bands - Map of band name to texture + UV transform.
 * @returns Props ready to pass to `{ module: CompositeBands, props: ... }`.
 *
 * @see {@link CompositeBands}
 */
export declare function buildCompositeBandsProps(mapping: {
    r: string;
    g?: string;
    b?: string;
    a?: string;
}, bands: Map<string, {
    texture: Texture;
    uvTransform: UvTransform;
}>): Partial<CompositeBandsProps>;
//# sourceMappingURL=composite-bands.d.ts.map