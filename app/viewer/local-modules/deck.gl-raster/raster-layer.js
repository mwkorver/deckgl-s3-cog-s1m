import { CompositeLayer } from "@deck.gl/core";
import { PolygonLayer } from "@deck.gl/layers";
import { RasterReprojector } from "@s3-cog/raster-reproject";
import { splitFloat64Array } from "./fp64.js";
import { buildUniformGridMesh } from "./globe-grid-mesh.js";
import { MeshTextureLayer } from "./mesh-layer/mesh-layer.js";
const DEFAULT_MAX_ERROR = 0.125;
const DEBUG_COLORS = [
    [252, 73, 163], // pink
    [255, 51, 204], // magenta-pink
    [204, 102, 255], // purple-ish
    [153, 51, 255], // deep purple
    [102, 204, 255], // sky blue
    [51, 153, 255], // clear blue
    [102, 255, 204], // teal
    [51, 255, 170], // aqua-teal
    [0, 255, 0], // lime green
    [51, 204, 51], // stronger green
    [255, 204, 102], // light orange
    [255, 179, 71], // golden-orange
    [255, 102, 102], // salmon
    [255, 80, 80], // red-salmon
    [255, 0, 0], // red
    [204, 0, 0], // crimson
    [255, 128, 0], // orange
    [255, 153, 51], // bright orange
    [255, 255, 102], // yellow
    [255, 255, 51], // lemon
    [0, 255, 255], // turquoise
    [0, 204, 255], // cyan
];
const defaultProps = {
    // A prop with `type: "image"` gets converted to a texture automatically by
    // deck.gl (as long as async: true)
    image: { type: "image", value: null, async: true },
    renderPipeline: { type: "array", value: [], compare: true },
    debug: false,
    debugOpacity: 0.5,
};
/**
 * Generic deck.gl layer for rendering geospatial raster data with client-side,
 * GPU-based reprojection and custom processing pipelines.
 *
 * This is a composite layer that uses {@link RasterReprojector} to generate an adaptive mesh
 * that accurately represents the reprojected raster, then renders it using
 * {@link MeshTextureLayer} (a small wrapper around a deck.gl
 * {@link SimpleMeshLayer}).
 */
export class RasterLayer extends CompositeLayer {
    static layerName = "RasterLayer";
    static defaultProps = defaultProps;
    initializeState() {
        this.setState({});
    }
    updateState(params) {
        super.updateState(params);
        const { props, oldProps, changeFlags } = params;
        // Regenerate mesh if key properties change.
        // Compare reprojectionFns members individually since callers may create a
        // new wrapper object on every render even when the functions are stable.
        const reprojectionFnsChanged = props.reprojectionFns.forwardTransform !==
            oldProps.reprojectionFns?.forwardTransform ||
            props.reprojectionFns.inverseTransform !==
                oldProps.reprojectionFns?.inverseTransform ||
            props.reprojectionFns.forwardReproject !==
                oldProps.reprojectionFns?.forwardReproject ||
            props.reprojectionFns.inverseReproject !==
                oldProps.reprojectionFns?.inverseReproject;
        const needsMeshUpdate = Boolean(changeFlags.dataChanged) ||
            props.width !== oldProps.width ||
            props.height !== oldProps.height ||
            reprojectionFnsChanged ||
            props.maxError !== oldProps.maxError;
        if (needsMeshUpdate) {
            this._generateMesh();
        }
    }
    _generateMesh() {
        const { width, height, reprojectionFns, maxError = DEFAULT_MAX_ERROR, } = this.props;
        // TEMPORARY GLOBE VIEW HACK:
        //
        // GlobeView (lnglat) uses viewport.resolution, the same detection as
        // RasterTileLayer. THROWAWAY: globe renders a uniform grid instead of the
        // adaptive mesh, because Delatin's reprojection-error metric is blind to
        // sphere curvature and facets at low zoom. See globe-grid-mesh.ts and
        // dev-docs/specs/2026-05-21-globe-view-design.md.
        const isGlobe = this.context?.viewport?.resolution !== undefined;
        if (isGlobe) {
            const { indices, positions64High, positions64Low, texCoords } = buildUniformGridMesh(reprojectionFns, width + 1, height + 1);
            this.setState({
                reprojector: undefined,
                mesh: {
                    indices: { value: indices, size: 1 },
                    attributes: {
                        POSITION: { value: positions64High, size: 3 },
                        TEXCOORD_0: { value: texCoords, size: 2 },
                    },
                },
                positions64Low,
            });
            return;
        }
        // The mesh is lined up with the upper and left edges of the raster. So if
        // we give the raster the same width and height as the number of pixels in
        // the image, it'll be omitting the last row and column of pixels.
        //
        // To account for this, we add 1 to both width and height when generating
        // the mesh. This also solves obvious gaps in between neighboring tiles in
        // the COGLayer.
        const reprojector = new RasterReprojector(reprojectionFns, width + 1, height + 1);
        reprojector.run(maxError);
        const { indices, positions64High, positions64Low, texCoords } = reprojectorToMesh(reprojector);
        this.setState({
            reprojector,
            mesh: {
                indices: { value: indices, size: 1 },
                attributes: {
                    POSITION: { value: positions64High, size: 3 },
                    TEXCOORD_0: { value: texCoords, size: 2 },
                },
            },
            positions64Low,
        });
    }
    renderDebugLayer() {
        const { reprojector } = this.state;
        const { debugOpacity } = this.props;
        if (!reprojector) {
            return null;
        }
        return new PolygonLayer(this.getSubLayerProps({
            id: "polygon",
            // https://deck.gl/docs/developer-guide/performance#supply-binary-blobs-to-the-data-prop
            // This `data` gets passed into `getPolygon` with the row index.
            data: { reprojector, length: reprojector.triangles.length / 3 },
            getPolygon: (_, { index, data, }) => {
                const triangles = data.reprojector.triangles;
                const positions = reprojector.exactOutputPositions;
                const a = triangles[index * 3];
                const b = triangles[index * 3 + 1];
                const c = triangles[index * 3 + 2];
                return [
                    [positions[a * 2], positions[a * 2 + 1]],
                    [positions[b * 2], positions[b * 2 + 1]],
                    [positions[c * 2], positions[c * 2 + 1]],
                    [positions[a * 2], positions[a * 2 + 1]],
                ];
            },
            getFillColor: (_, { index, target }) => {
                const color = DEBUG_COLORS[index % DEBUG_COLORS.length];
                target[0] = color[0];
                target[1] = color[1];
                target[2] = color[2];
                target[3] = 255;
                return target;
            },
            getLineColor: [0, 0, 0],
            getLineWidth: 1,
            lineWidthUnits: "pixels",
            opacity: debugOpacity !== undefined && Number.isFinite(debugOpacity)
                ? Math.max(0, Math.min(1, debugOpacity))
                : 1,
            pickable: false,
        }));
    }
    renderLayers() {
        const { mesh, positions64Low } = this.state;
        const { debug, image, renderPipeline } = this.props;
        // mesh and positions64Low are always set together by _generateMesh.
        if (!mesh ||
            !positions64Low ||
            (!image && (renderPipeline?.length ?? 0) === 0)) {
            return null;
        }
        const meshLayer = new MeshTextureLayer(this.getSubLayerProps({
            id: "raster",
            image,
            renderPipeline,
            // Single mesh rendered as one non-instanced draw.
            data: { length: 1, attributes: { positions64Low } },
            mesh,
            // We give a white color to turn off color mixing with the texture.
            getColor: [255, 255, 255],
        }));
        const layers = [meshLayer];
        if (debug) {
            const debugLayer = this.renderDebugLayer();
            if (debugLayer) {
                layers.push(debugLayer);
            }
        }
        return layers;
    }
}
function reprojectorToMesh(reprojector) {
    const numVertices = reprojector.uvs.length / 2;
    const texCoords = new Float32Array(reprojector.uvs);
    const positions = new Float64Array(numVertices * 3);
    for (let i = 0; i < numVertices; i++) {
        positions[i * 3] = reprojector.exactOutputPositions[i * 2];
        positions[i * 3 + 1] = reprojector.exactOutputPositions[i * 2 + 1];
        // z (flat on the ground)
        positions[i * 3 + 2] = 0;
    }
    // Split the float64 positions into high and low parts for fp64 emulation in
    // the shader.
    const [positions64Low, positions64High] = splitFloat64Array(positions);
    // TODO: Consider using 16-bit indices if the mesh is small enough
    const indices = new Uint32Array(reprojector.triangles);
    return {
        indices,
        positions64High,
        positions64Low,
        texCoords,
    };
}
//# sourceMappingURL=raster-layer.js.map