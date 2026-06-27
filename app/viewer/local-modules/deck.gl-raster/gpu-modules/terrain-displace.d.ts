import type { Texture } from "@luma.gl/core";
/** Props for the {@link TerrainDisplace} shader module. */
export type TerrainDisplaceProps = {
    /** Single-channel (r32float) elevation texture, sampled by `geometry.uv`. */
    elevationTexture: Texture;
    /** Vertical exaggeration applied to (elevation - zmin). */
    exag: number;
    /** Elevation that maps to z=0 (typically the tile minimum). */
    zmin: number;
    /** Elevation span (max - min) for the hypsometric colour ramp. */
    zspan: number;
    /** Sentinel elevation treated as void (no displacement, fragment discarded). */
    nodata: number;
    /** 1 / (gridWidth, gridHeight) — neighbour step in UV space for normals. */
    texel: [number, number];
    /** Ground cell size (east, north) in metres — scales the normal gradient. */
    stepm: [number, number];
    /** When non-zero, output grayscale hillshade for a later imagery drape module. */
    shadeOnly?: number;
};
/**
 * Turns {@link MeshTextureLayer}'s flat draped mesh into 3D terrain entirely on
 * the GPU: the vertex shader samples a single-channel elevation texture and
 * displaces each vertex's z (in the model's metre space) via the
 * `DECKGL_FILTER_SIZE` hook, while the fragment shader derives a per-pixel
 * normal from the elevation gradient for hillshading and a hypsometric colour
 * ramp. Elevation stays a GPU texture — no per-vertex CPU work and no re-mesh —
 * so vertical exaggeration is a free uniform change.
 *
 * Used via {@link TerrainMeshLayer} (which owns the texture lifecycle) but kept
 * a standalone module so it can be composed into other render pipelines.
 */
export declare const TerrainDisplace: {
    readonly name: "terrain";
    readonly vs: string;
    readonly fs: string;
    readonly inject: {
        readonly "vs:DECKGL_FILTER_SIZE": "\n  {\n    float e = texture(elevationTexture, geometry.uv).r;\n    size.z += (e == terrain.nodata) ? 0.0 : (e - terrain.zmin) * terrain.exag;\n  }\n";
        readonly "fs:DECKGL_FILTER_COLOR": "\n  {\n    vec2 uv = geometry.uv;\n    float e = texture(elevationTexture, uv).r;\n    if (e == terrain.nodata) discard;\n    float t = clamp((e - terrain.zmin) / terrain.zspan, 0.0, 1.0);\n    float eL = texture(elevationTexture, uv - vec2(terrain.texel.x, 0.0)).r;\n    float eR = texture(elevationTexture, uv + vec2(terrain.texel.x, 0.0)).r;\n    float eU = texture(elevationTexture, uv - vec2(0.0, terrain.texel.y)).r;\n    float eD = texture(elevationTexture, uv + vec2(0.0, terrain.texel.y)).r;\n    vec3 n = normalize(vec3(\n      -(eR - eL) * terrain.exag / (2.0 * terrain.stepm.x),\n       (eU - eD) * terrain.exag / (2.0 * terrain.stepm.y),\n       1.0));\n    float lambert = clamp(dot(n, normalize(vec3(0.5, 0.6, 0.8))), 0.0, 1.0) * 0.7 + 0.35;\n    color = terrain.shadeOnly > 0.5\n      ? vec4(vec3(0.32, 0.41, 0.34) * lambert, lambert)\n      : vec4(terrainHypso(t) * lambert, 1.0);\n  }\n";
    };
    readonly uniformTypes: {
        readonly exag: "f32";
        readonly zmin: "f32";
        readonly zspan: "f32";
        readonly nodata: "f32";
        readonly texel: "vec2<f32>";
        readonly stepm: "vec2<f32>";
        readonly shadeOnly: "f32";
    };
    readonly getUniforms: (props?: Partial<TerrainDisplaceProps>) => {
        elevationTexture: Texture | undefined;
        exag: number;
        zmin: number;
        zspan: number;
        nodata: number;
        texel: [number, number];
        stepm: [number, number];
        shadeOnly: number;
    };
};
//# sourceMappingURL=terrain-displace.d.ts.map