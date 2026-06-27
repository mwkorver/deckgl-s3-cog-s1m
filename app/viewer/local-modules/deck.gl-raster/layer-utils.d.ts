import type { _Tile2DHeader as Tile2DHeader } from "@deck.gl/geo-layers";
import { PathLayer, TextLayer } from "@deck.gl/layers";
import type { ReprojectionFns } from "@s3-cog/raster-reproject";
import type { RasterTileMetadata } from "./raster-tileset/index.js";
export declare function renderDebugTileOutline(id: string, tile: Tile2DHeader & RasterTileMetadata, forwardTo4326: ReprojectionFns["forwardReproject"]): (TextLayer<any, {
    id: `${string}-label`;
    data: {
        position: number[];
        text: string;
    }[];
    getColor: [number, number, number, number];
    getSize: 24;
    sizeUnits: "pixels";
    outlineWidth: 3;
    outlineColor: [number, number, number, number];
    fontSettings: {
        sdf: true;
    };
}> | PathLayer<any, {
    id: string;
    data: [number, number][][];
    getPath: (d: any) => any;
    getColor: [number, number, number, number];
    getWidth: 2;
    widthUnits: "pixels";
    pickable: false;
}>)[];
//# sourceMappingURL=layer-utils.d.ts.map