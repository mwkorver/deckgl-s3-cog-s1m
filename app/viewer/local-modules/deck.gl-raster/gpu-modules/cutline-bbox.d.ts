/** Props for the {@link CutlineBbox} shader module. */
export type CutlineBboxProps = {
    /**
     * Axis-aligned clip region in deck.gl **common space** (world units),
     * packed as `[minX, minY, maxX, maxY]`. This must be in the same coordinate
     * space as the layer's mesh `positions` attribute — for `COGLayer` /
     * `RasterLayer`'s Web Mercator rendering path, that is deck.gl common space.
     *
     * Project a WGS84 lng/lat bbox to common space **once at bbox definition
     * time** with deck.gl's `WebMercatorViewport.projectPosition` (or
     * `@math.gl/web-mercator`'s `lngLatToWorld`). Do *not* convert per frame:
     * `getUniforms` here is a pass-through, but luma.gl calls it on every
     * `setProps` (i.e. every draw), so any projection placed in it would run
     * each animation frame.
     */
    bbox: [minX: number, minY: number, maxX: number, maxY: number];
};
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
export declare const CutlineBbox: {
    readonly name: "cutlineBbox";
    readonly fs: "uniform cutlineBboxUniforms {\n  vec4 bbox;\n} cutlineBbox;\n";
    readonly inject: {
        readonly "vs:#decl": "out vec2 v_cutlineBboxCommon;";
        readonly "vs:#main-start": "\n      v_cutlineBboxCommon = positions.xy;\n    ";
        readonly "fs:#decl": "in vec2 v_cutlineBboxCommon;";
        readonly "fs:#main-start": "\n      {\n        if (v_cutlineBboxCommon.x < cutlineBbox.bbox.x ||\n            v_cutlineBboxCommon.x > cutlineBbox.bbox.z ||\n            v_cutlineBboxCommon.y < cutlineBbox.bbox.y ||\n            v_cutlineBboxCommon.y > cutlineBbox.bbox.w) {\n          discard;\n        }\n      }\n    ";
    };
    readonly uniformTypes: {
        readonly bbox: "vec4<f32>";
    };
    readonly getUniforms: (props: Partial<CutlineBboxProps>) => {
        bbox: [minX: number, minY: number, maxX: number, maxY: number];
    } | {
        bbox?: undefined;
    };
};
//# sourceMappingURL=cutline-bbox.d.ts.map