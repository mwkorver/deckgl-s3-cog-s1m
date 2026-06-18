import type { DefaultProps, UpdateParameters } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import { DrapeTexture } from "../gpu-modules/drape-texture.js";
import { TerrainDisplace } from "../gpu-modules/terrain-displace.js";
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

const defaultProps: DefaultProps<TerrainMeshLayerProps> = {
  ...(MeshTextureLayer.defaultProps as DefaultProps<TerrainMeshLayerProps>),
  elevationData: { type: "object", value: null, async: false },
  gridWidth: { type: "number", value: 0 },
  gridHeight: { type: "number", value: 0 },
  exag: { type: "number", value: 1 },
  zmin: { type: "number", value: 0 },
  zspan: { type: "number", value: 1 },
  nodata: { type: "number", value: -999999 },
  stepX: { type: "number", value: 1 },
  stepY: { type: "number", value: 1 },
  drapeImage: { type: "object", value: null, async: false },
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
export class TerrainMeshLayer extends MeshTextureLayer {
  static override layerName = "terrain-mesh-layer";
  static override defaultProps = defaultProps as typeof MeshTextureLayer.defaultProps;

  override updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    const state = this.state as { elevationTexture?: Texture; drapeTexture?: Texture };
    // (Re)upload the elevation texture only when the data changes -- not when
    // only `exag` (a uniform) changes, so exaggeration is free.
    const p = props as unknown as TerrainMeshLayerProps;
    const data = p.elevationData;
    if (data && (!state.elevationTexture || data !== (oldProps as unknown as TerrainMeshLayerProps).elevationData)) {
      state.elevationTexture?.destroy?.();
      state.elevationTexture = this.context.device.createTexture({
        data,
        format: "r32float",
        width: p.gridWidth,
        height: p.gridHeight,
        sampler: { minFilter: "nearest", magFilter: "nearest" },
      });
    }
    if (
      p.drapeImage &&
      (!state.drapeTexture || p.drapeImage !== (oldProps as unknown as TerrainMeshLayerProps).drapeImage)
    ) {
      if (!(oldProps as unknown as TerrainMeshLayerProps).drapeImage) {
        params.changeFlags.extensionsChanged = true;
      }
      state.drapeTexture?.destroy?.();
      state.drapeTexture = this.context.device.createTexture({
        data: p.drapeImage,
        width: p.drapeImage.width,
        height: p.drapeImage.height,
        format: "rgba8unorm",
        sampler: { minFilter: "linear", magFilter: "linear" },
      });
    } else if (!p.drapeImage && state.drapeTexture) {
      params.changeFlags.extensionsChanged = true;
      state.drapeTexture.destroy?.();
      state.drapeTexture = undefined;
    }
    super.updateState(params);
  }

  // Inject TerrainDisplace (carrying the live texture + uniforms) as the sole
  // render-pipeline step; MeshTextureLayer adds it to the shader modules in
  // getShaders() and pushes its props to the model in draw().
  override _resolveRenderPipeline(): RasterModule[] {
    const p = this.props as unknown as TerrainMeshLayerProps;
    const state = this.state as { elevationTexture?: Texture; drapeTexture?: Texture };
    const pipeline: RasterModule[] = [
      {
        module: TerrainDisplace,
        props: {
          elevationTexture: state.elevationTexture as Texture,
          exag: p.exag,
          zmin: p.zmin,
          zspan: p.zspan,
          nodata: p.nodata,
          texel: [1 / p.gridWidth, 1 / p.gridHeight],
          stepm: [p.stepX, p.stepY],
          shadeOnly: state.drapeTexture ? 1 : 0,
        },
      },
    ];
    if (state.drapeTexture) {
      pipeline.push({
        module: DrapeTexture,
        props: { drapeTexture: state.drapeTexture },
      });
    }
    return pipeline;
  }

  override finalizeState(context: unknown): void {
    (this.state as { elevationTexture?: Texture; drapeTexture?: Texture }).elevationTexture?.destroy?.();
    (this.state as { drapeTexture?: Texture }).drapeTexture?.destroy?.();
    // @ts-expect-error -- forward to SimpleMeshLayer's finalizeState signature
    super.finalizeState(context);
  }
}
