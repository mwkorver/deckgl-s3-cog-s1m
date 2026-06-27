import type { DefaultProps, TextureSource, UpdateParameters } from "@deck.gl/core";
import type { SimpleMeshLayerProps } from "@deck.gl/mesh-layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { RasterModule } from "../gpu-modules/types.js";
/**
 * `SimpleMeshLayer` props that `MeshTextureLayer` deliberately does not
 * support. They configure per-instance 3D-model placement, which is
 * meaningless for our single-mesh-at-the-origin use case — and a non-identity
 * value would silently break the fp64 mesh-vertex precision correction (the
 * `positions64Low` low part is the residual of `positions`, not of a
 * transformed `pos`). They are fixed internally (see `defaultProps`) and
 * omitted from the public prop type so they can't be set.
 */
type ExcludedSimpleMeshProps = "_instanced" | "getPosition" | "getOrientation" | "getScale" | "getTranslation" | "getTransformMatrix" | "sizeScale";
type _MeshTextureLayerProps = {
    image: TextureSource;
    renderPipeline?: RasterModule[];
} | {
    renderPipeline: RasterModule[];
    image?: TextureSource;
};
export type MeshTextureLayerProps = Omit<SimpleMeshLayerProps, ExcludedSimpleMeshProps> & _MeshTextureLayerProps;
declare const defaultProps: DefaultProps<SimpleMeshLayerProps & {
    image: TextureSource | null;
    renderPipeline: RasterModule[];
}>;
/**
 * A specialized raster-rendering layer, spiritually based on deck.gl's
 * `SimpleMeshLayer` but with a narrower purpose: it draws **one** texture-mapped
 * mesh anchored at the coordinate origin, not instanced 3D models.
 *
 * Differences from `SimpleMeshLayer`:
 * - Allows dynamic shader injection (a render pipeline of `RasterModule`s) and
 *   overrides the vertex/fragment shaders.
 * - Provides fp64 mesh-vertex precision via a `positions64Low` attribute paired
 *   with the geometry's `positions` (supplied by the caller through
 *   `data.attributes.positions64Low`).
 * - The per-instance placement props (`_instanced`, `getPosition`,
 *   `getOrientation`, `getScale`, `getTranslation`, `getTransformMatrix`,
 *   `sizeScale`) are intentionally unsupported and fixed at identity — see
 *   {@link ExcludedSimpleMeshProps}. This is what keeps the fp64 correction
 *   valid (the low part is the residual of `positions`, not of a transformed
 *   vertex).
 */
export declare class MeshTextureLayer extends SimpleMeshLayer<null, MeshTextureLayerProps> {
    static layerName: string;
    static defaultProps: typeof defaultProps;
    initializeState(): void;
    _resolveRenderPipeline(): RasterModule[];
    updateState(params: UpdateParameters<this>): void;
    /** Returns true if the render pipeline has changed between the old and new props. */
    private hasRenderPipelineChanged;
    getShaders(): any;
    draw(opts: any): void;
}
export {};
//# sourceMappingURL=mesh-layer.d.ts.map