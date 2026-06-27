import type { UpdateParameters } from "@deck.gl/core";
import type { RasterModule } from "../gpu-modules/types.js";
import { MeshTextureLayer, type MeshTextureLayerProps } from "./mesh-layer.js";
/** Props added by {@link TerrainMeshLayer} on top of {@link MeshTextureLayer}. */
export type TerrainMeshLayerProps = Omit<MeshTextureLayerProps, "image" | "renderPipeline"> & {
    /** Row-major single-channel elevation grid (gridWidth × gridHeight). */
    elevationData: Float32Array | null;
    gridWidth: number;
    gridHeight: number;
    /** Vertical exaggeration (a uniform — changing it does not rebuild the mesh). */
    exag: number;
    /** Elevation mapped to z=0 (tile minimum), and the span for the colour ramp. */
    zmin: number;
    zspan: number;
    /** Void sentinel in `elevationData` (vertices undisplaced, fragments dropped). */
    nodata: number;
    /** Ground cell size (east, north) in metres. */
    stepX: number;
    stepY: number;
    /** Optional imagery image/texture source draped over the displaced terrain. */
    drapeImage?: ImageData | null;
};
/**
 * GPU vertex-displacement terrain built on {@link MeshTextureLayer}: the caller
 * supplies a flat draped grid (POSITION at z=0 + TEXCOORD_0, plus the fp64
 * `positions64Low` attribute) and an elevation grid; this layer uploads the
 * elevation once as an r32float texture and runs the {@link TerrainDisplace}
 * module, which displaces each vertex's z and hillshades/colours it per-pixel.
 *
 * Because elevation lives in a texture and exaggeration is a uniform, changing
 * exaggeration is free (no re-mesh, no CPU work) — the GPU-path advantage over a
 * CPU-baked height mesh. Reuses MeshTextureLayer's fp64 precision and v9 shader
 * assembly, so the displacement compiles cleanly across deck.gl's render passes.
 */
export declare class TerrainMeshLayer extends MeshTextureLayer {
    static layerName: string;
    static defaultProps: typeof MeshTextureLayer.defaultProps;
    updateState(params: UpdateParameters<this>): void;
    _resolveRenderPipeline(): RasterModule[];
    finalizeState(context: unknown): void;
}
//# sourceMappingURL=terrain-mesh-layer.d.ts.map