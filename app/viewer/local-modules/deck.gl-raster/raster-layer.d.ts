import type { CompositeLayerProps, DefaultProps, Layer, TextureSource, UpdateParameters } from "@deck.gl/core";
import { CompositeLayer } from "@deck.gl/core";
import type { ReprojectionFns } from "@s3-cog/raster-reproject";
import { RasterReprojector } from "@s3-cog/raster-reproject";
import type { RasterModule } from "./gpu-modules/types.js";
/**
 * The result returned by a `renderTile` function.
 *
 * Must contain at least one of `image` or `renderPipeline`. If both are
 * provided, `image` is prepended as a `CreateTexture` module so the pipeline
 * can operate on it.
 */
export type RenderTileResult = {
    image: TextureSource;
    renderPipeline?: RasterModule[];
} | {
    renderPipeline: RasterModule[];
    image?: TextureSource;
};
/**
 * Props for {@link RasterLayer}.
 */
export interface RasterLayerProps extends CompositeLayerProps {
    /**
     * Width of the input raster image in pixels
     */
    width: number;
    /**
     * Height of the input raster image in pixels
     */
    height: number;
    /**
     * Reprojection functions for converting between pixel, input CRS, and output CRS coordinates
     */
    reprojectionFns: ReprojectionFns;
    /**
     * The image to display. Accepts any luma.gl `TextureSource` (e.g. a URL,
     * `HTMLImageElement`, `ImageData`, etc.). deck.gl manages the texture
     * lifecycle automatically.
     *
     * If `renderPipeline` is also provided, `image` is prepended as a
     * `CreateTexture` module so the pipeline can operate on it.
     *
     * @default null
     */
    image?: TextureSource | null;
    /**
     * Sequence of shader modules to be composed into a render pipeline.
     *
     * If `image` is also provided, it is automatically prepended as a
     * `CreateTexture` module.
     */
    renderPipeline?: RasterModule[] | null;
    /**
     * Maximum reprojection error in pixels for mesh refinement.
     * Lower values create denser meshes with higher accuracy.
     * @default 0.125
     */
    maxError?: number;
    /** If set, enables debug mode for visualizing the mesh and reprojection process. */
    debug?: boolean;
    /** Opacity of the debug overlay. */
    debugOpacity?: number;
}
/**
 * Generic deck.gl layer for rendering geospatial raster data with client-side,
 * GPU-based reprojection and custom processing pipelines.
 *
 * This is a composite layer that uses {@link RasterReprojector} to generate an adaptive mesh
 * that accurately represents the reprojected raster, then renders it using
 * {@link MeshTextureLayer} (a small wrapper around a deck.gl
 * {@link SimpleMeshLayer}).
 */
export declare class RasterLayer extends CompositeLayer<RasterLayerProps> {
    static layerName: string;
    static defaultProps: DefaultProps<RasterLayerProps>;
    state: {
        reprojector?: RasterReprojector;
        /**
         * Mesh in the exact shape SimpleMeshLayer expects.
         *
         * It's important for this to be passed to MeshTextureLayer as a stable
         * reference so `props.mesh` equality holds across renders. This avoids
         * unnecessarily recreating the model.
         */
        mesh?: {
            indices: {
                value: Uint32Array;
                size: number;
            };
            attributes: {
                POSITION: {
                    value: Float32Array;
                    size: number;
                };
                TEXCOORD_0: {
                    value: Float32Array;
                    size: number;
                };
            };
        };
        /**
         * Low-part of positions for fp64 emulation in the shaders.
         * `mesh.attributes.POSITION` carries the high part.
         *
         * This needs to be passed separately from `mesh` because SimpleMeshLayer's
         * `normalizeGeometryAttributes` whitelists only positions/colors/normals/
         * texCoords on the mesh attributes object — anything else is silently
         * dropped.
         */
        positions64Low?: Float32Array;
    };
    initializeState(): void;
    updateState(params: UpdateParameters<this>): void;
    protected _generateMesh(): void;
    renderDebugLayer(): Layer | null;
    renderLayers(): Layer<{}>[] | null;
}
//# sourceMappingURL=raster-layer.d.ts.map