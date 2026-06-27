const MODULE_NAME = "cutlineBbox";
const uniformBlock = `\
uniform ${MODULE_NAME}Uniforms {
  vec4 bbox;
} ${MODULE_NAME};
`;
/**
 * A shader module that discards fragments whose position falls outside an
 * axis-aligned common-space bbox.
 *
 * Intended for rendering rasters with a "map collar" (e.g. USGS historical
 * topographic maps) where the valid data area is described as a bbox but
 * the raw pixels include surrounding metadata.
 *
 * Only supports rendering in a `WebMercatorViewport`. The caller is
 * responsible for enforcing this in application code; the module itself
 * does not have viewport access.
 *
 * The module assumes the layer's mesh `positions` attribute is in deck.gl
 * **common space** (world units) — the convention used by `COGLayer` /
 * `RasterLayer` in the Web Mercator rendering path. It injects a vertex
 * shader varying that passes each vertex's common-space position through to
 * the fragment shader, and compares against a uniform bbox also in common
 * space. Capturing the raw `positions` attribute (rather than deck.gl's
 * viewport-anchored, camera-relative `position_commonspace`) keeps the test
 * stable across zoom levels.
 */
export const CutlineBbox = {
    name: MODULE_NAME,
    fs: uniformBlock,
    inject: {
        // Declare the common-space varying on both sides of the pipeline.
        "vs:#decl": `out vec2 v_cutlineBboxCommon;`,
        // `positions` is the per-vertex attribute the SimpleMeshLayer vertex
        // shader reads (see @deck.gl/mesh-layers simple-mesh-layer-vertex.glsl).
        // In COGLayer's CARTESIAN + web-mercator path this attribute is in deck.gl
        // common space. We capture it before any projection is applied.
        "vs:#main-start": /* glsl */ `
      v_cutlineBboxCommon = positions.xy;
    `,
        "fs:#decl": `in vec2 v_cutlineBboxCommon;`,
        // Injects at fs:#main-start (not fs:DECKGL_FILTER_COLOR). The
        // DECKGL_FILTER_COLOR hook is a generated function whose body is assembled
        // before the main FS source; top-level FS varyings declared in the main
        // source are out of scope there. Injecting at #main-start puts this test
        // inside main() where the varying is visible and discard still works.
        //
        // Globe support: when rendering in a GlobeView, the mesh positions are in
        // 4326 lng/lat rather than common space, so this exact varying is no
        // longer meaningful. A future globe code path would need a different
        // varying (e.g. lng/lat pair) and matching uniform layout.
        "fs:#main-start": /* glsl */ `
      {
        if (v_cutlineBboxCommon.x < ${MODULE_NAME}.bbox.x ||
            v_cutlineBboxCommon.x > ${MODULE_NAME}.bbox.z ||
            v_cutlineBboxCommon.y < ${MODULE_NAME}.bbox.y ||
            v_cutlineBboxCommon.y > ${MODULE_NAME}.bbox.w) {
          discard;
        }
      }
    `,
    },
    uniformTypes: {
        bbox: "vec4<f32>",
    },
    // Pass-through: the bbox is expected to already be in common space. Projection
    // from WGS84 is done once at bbox definition time (see the prop docs), not
    // here — luma.gl calls getUniforms on every setProps / draw.
    getUniforms: (props) => props.bbox ? { bbox: props.bbox } : {},
};
//# sourceMappingURL=cutline-bbox.js.map