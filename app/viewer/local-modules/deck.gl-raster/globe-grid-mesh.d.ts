import type { ReprojectionFns } from "@s3-cog/raster-reproject";
/**
 * Default per-tile grid resolution for the globe scaffold. An `n × n` grid of
 * cells (so `(n+1)²` vertices). 32 keeps low-zoom tiles smooth on the sphere
 * while staying cheap (≈1089 verts / 2048 triangles per tile).
 */
export declare const GLOBE_GRID_SIZE = 32;
/**
 * THROWAWAY globe scaffold. Builds a uniform `gridSize × gridSize` triangle
 * grid over a tile in UV space and reprojects each vertex through the same
 * `forwardTransform` → `forwardReproject` chain {@link RasterReprojector} uses,
 * producing output positions in the layer's output CRS (lng/lat in globe mode).
 *
 * Why this exists: the adaptive Delatin mesh subdivides on *reprojection*
 * error, which is ~0 for an EPSG:4326 source, so it emits 2 triangles that
 * chord straight through the sphere and visibly facet at low zoom. A uniform
 * grid is a stopgap so the prototype is legible. It is NOT the real fix —
 * remove it once sphere-aware reprojection lands. See
 * `dev-docs/specs/2026-05-21-globe-view-design.md`.
 *
 * `width`/`height` match {@link RasterReprojector}'s convention (pass the
 * image dimensions + 1); pixel coordinates span `[0, width-1] × [0, height-1]`.
 */
export declare function buildUniformGridMesh(reprojectionFns: ReprojectionFns, width: number, height: number, gridSize?: number): {
    indices: Uint32Array;
    positions64High: Float32Array;
    positions64Low: Float32Array;
    texCoords: Float32Array;
};
//# sourceMappingURL=globe-grid-mesh.d.ts.map