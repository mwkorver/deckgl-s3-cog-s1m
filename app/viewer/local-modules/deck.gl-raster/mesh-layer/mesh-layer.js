import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { CreateTexture } from "../gpu-modules/create-texture.js";
import fs from "./mesh-layer-fragment.glsl.js";
import vs from "./mesh-layer-vertex.glsl.js";
const defaultProps = {
    ...SimpleMeshLayer.defaultProps,
    // Note: putting `image` in defaultProps causes Maplibre to fail to render
    // labels in interleaved mode 🤷‍♂️
    // image: { type: "image", value: null, async: true },
    renderPipeline: { type: "array", value: [], compare: true },
    // Render exactly one non-instanced mesh anchored at the coordinate origin.
    _instanced: false,
    getPosition: { type: "accessor", value: [0, 0, 0] },
    // Disable lighting by default (avoids darkening raster)
    material: {
        ambient: 1.0,
        diffuse: 0.0,
        shininess: 0,
        specularColor: [0, 0, 0],
    },
};
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
export class MeshTextureLayer extends SimpleMeshLayer {
    static layerName = "mesh-texture-layer";
    static defaultProps = defaultProps;
    initializeState() {
        super.initializeState();
        const attributeManager = this.getAttributeManager();
        if (attributeManager) {
            // Register the per-vertex low part of the fp64 position split, supplied
            // via `data.attributes.positions64Low`
            attributeManager.add({
                positions64Low: {
                    size: 3,
                    type: "float32",
                    // Tell the AttributeManager not to allocate a buffer for this
                    // attribute; we'll supply it externally
                    noAlloc: true,
                },
            });
        }
    }
    _resolveRenderPipeline() {
        const { image, renderPipeline } = this.props;
        const imageModule = image
            ? [{ module: CreateTexture, props: { textureName: image } }]
            : [];
        return [...imageModule, ...(renderPipeline ?? [])];
    }
    updateState(params) {
        // Ensure the SimpleMeshLayer rebuilds the model when the renderPipeline has
        // changed.
        if (this.hasRenderPipelineChanged(params)) {
            // Setting extensionsChanged to true causes recompiling the shader
            // https://github.com/visgl/deck.gl/blob/70adde2f1fcdf5e99195df81512e6d01ee7a5edc/modules/mesh-layers/src/simple-mesh-layer/simple-mesh-layer.ts#L284-L297
            params.changeFlags.extensionsChanged = true;
        }
        super.updateState(params);
    }
    /** Returns true if the render pipeline has changed between the old and new props. */
    hasRenderPipelineChanged(params) {
        const { oldProps, props: newProps } = params;
        if (Boolean(oldProps.image) !== Boolean(newProps.image)) {
            return true;
        }
        const oldPipeline = oldProps.renderPipeline ?? [];
        const newPipeline = newProps.renderPipeline ?? [];
        if (oldPipeline.length !== newPipeline.length) {
            return true;
        }
        for (let i = 0; i < oldPipeline.length; i++) {
            if (oldPipeline[i]?.module.name !== newPipeline[i]?.module.name) {
                return true;
            }
        }
        return false;
    }
    getShaders() {
        const upstreamShaders = super.getShaders();
        const modules = upstreamShaders.modules;
        for (const m of this._resolveRenderPipeline()) {
            modules.push(m.module);
        }
        return {
            ...upstreamShaders,
            // Override upstream's vertex shader with our copy that uses fp64
            // emulation
            vs,
            // Override upstream's fragment shader with our copy with modified
            // injection points
            fs,
            modules,
        };
    }
    draw(opts) {
        const shaderProps = {};
        for (const m of this._resolveRenderPipeline()) {
            // Props should be keyed by module name
            shaderProps[m.module.name] = m.props || {};
        }
        for (const m of super.getModels()) {
            m.shaderInputs.setProps(shaderProps);
        }
        super.draw(opts);
    }
}
//# sourceMappingURL=mesh-layer.js.map