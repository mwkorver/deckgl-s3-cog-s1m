const MODULE_NAME = "terrain";
// std140 UBO block; field order must match `uniformTypes`. Declared explicitly
// because luma.gl v9 does not generate the block from uniformTypes (see the
// sibling LinearRescale module). Declared in both stages so the displacement
// (vertex) and the hillshade/colour (fragment) can both read it.
const UBO = /* glsl */ `uniform ${MODULE_NAME}Uniforms {
  float exag;
  float zmin;
  float zspan;
  float nodata;
  vec2 texel;
  vec2 stepm;
  float shadeOnly;
} ${MODULE_NAME};
`;
const SAMPLER = /* glsl */ `uniform sampler2D elevationTexture;`;
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
export const TerrainDisplace = {
    name: MODULE_NAME,
    vs: UBO + SAMPLER,
    fs: UBO +
        SAMPLER +
        /* glsl */ `
vec3 terrainHypso(float t) {
  vec3 c = mix(vec3(0.24, 0.47, 0.24), vec3(0.47, 0.59, 0.31), smoothstep(0.0, 0.4, t));
  c = mix(c, vec3(0.67, 0.55, 0.39), smoothstep(0.4, 0.7, t));
  c = mix(c, vec3(0.75, 0.69, 0.63), smoothstep(0.7, 0.9, t));
  c = mix(c, vec3(0.96, 0.96, 0.96), smoothstep(0.9, 1.0, t));
  return c;
}
`,
    inject: {
        // `size` is the model-space vertex (metres); geometry.uv is already set.
        "vs:DECKGL_FILTER_SIZE": /* glsl */ `
  {
    float e = texture(elevationTexture, geometry.uv).r;
    size.z += (e == ${MODULE_NAME}.nodata) ? 0.0 : (e - ${MODULE_NAME}.zmin) * ${MODULE_NAME}.exag;
  }
`,
        "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  {
    vec2 uv = geometry.uv;
    float e = texture(elevationTexture, uv).r;
    if (e == ${MODULE_NAME}.nodata) discard;
    float t = clamp((e - ${MODULE_NAME}.zmin) / ${MODULE_NAME}.zspan, 0.0, 1.0);
    float eL = texture(elevationTexture, uv - vec2(${MODULE_NAME}.texel.x, 0.0)).r;
    float eR = texture(elevationTexture, uv + vec2(${MODULE_NAME}.texel.x, 0.0)).r;
    float eU = texture(elevationTexture, uv - vec2(0.0, ${MODULE_NAME}.texel.y)).r;
    float eD = texture(elevationTexture, uv + vec2(0.0, ${MODULE_NAME}.texel.y)).r;
    vec3 n = normalize(vec3(
      -(eR - eL) * ${MODULE_NAME}.exag / (2.0 * ${MODULE_NAME}.stepm.x),
       (eU - eD) * ${MODULE_NAME}.exag / (2.0 * ${MODULE_NAME}.stepm.y),
       1.0));
    float lambert = clamp(dot(n, normalize(vec3(0.5, 0.6, 0.8))), 0.0, 1.0) * 0.7 + 0.35;
    color = ${MODULE_NAME}.shadeOnly > 0.5
      ? vec4(vec3(0.32, 0.41, 0.34) * lambert, lambert)
      : vec4(terrainHypso(t) * lambert, 1.0);
  }
`,
    },
    uniformTypes: {
        exag: "f32",
        zmin: "f32",
        zspan: "f32",
        nodata: "f32",
        texel: "vec2<f32>",
        stepm: "vec2<f32>",
        shadeOnly: "f32",
    },
    getUniforms: (props = {}) => {
        return {
            elevationTexture: props.elevationTexture,
            exag: props.exag ?? 1.0,
            zmin: props.zmin ?? 0.0,
            zspan: props.zspan ?? 1.0,
            nodata: props.nodata ?? -999999.0,
            texel: props.texel ?? [0.0, 0.0],
            stepm: props.stepm ?? [1.0, 1.0],
            shadeOnly: props.shadeOnly ?? 0,
        };
    },
};
//# sourceMappingURL=terrain-displace.js.map