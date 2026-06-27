/**
 * This is a vendored copy of the SimpleMeshLayer's fragment shader:
 * https://github.com/visgl/deck.gl/blob/a15c8cea047993c8a861bf542835c1988f30165c/modules/mesh-layers/src/simple-mesh-layer/simple-mesh-layer-fragment.glsl.ts
 * under the MIT license.
 *
 * We edited this to remove the hard-coded texture uniform because we want to
 * support integer and signed integer textures, not only normalized unsigned
 * textures.
 */
declare const _default: "#version 300 es\n#define SHADER_NAME mesh-texture-layer-fs\n\nprecision highp float;\n\n// Declare the base SimpleMeshLayer sampler to satisfy deck.gl/luma.gl v9 bindings\nuniform sampler2D sampler;\n\nin vec2 vTexCoord;\nin vec3 cameraPosition;\nin vec3 normals_commonspace;\nin vec4 position_commonspace;\nin vec4 vColor;\n\nout vec4 fragColor;\n\nvoid main(void) {\n  geometry.uv = vTexCoord;\n\n  vec3 normal;\n  if (simpleMesh.flatShading) {\n\n  normal = normalize(cross(dFdx(position_commonspace.xyz), dFdy(position_commonspace.xyz)));\n  } else {\n    normal = normals_commonspace;\n  }\n\n  // We initialize color here before passing into DECKGL_FILTER_COLOR\n  vec4 color;\n  DECKGL_FILTER_COLOR(color, geometry);\n\n  vec3 lightColor = lighting_getLightColor(color.rgb, cameraPosition, position_commonspace.xyz, normal);\n  fragColor = vec4(lightColor, color.a * layer.opacity);\n\n  // Unconditional epsilon read keeps 'sampler' live through GLSL dead-code\n  // elimination, preventing luma.gl v9 binding layout mismatch errors.\n  fragColor.a += texture(sampler, vec2(0.0)).a * 0.00001;\n}\n";
export default _default;
//# sourceMappingURL=mesh-layer-fragment.glsl.d.ts.map