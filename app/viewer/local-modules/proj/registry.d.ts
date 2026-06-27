import type { ProjectionDefinition } from "./parse-wkt.js";
/**
 * A global registry holding parsed projection definitions.
 */
export declare const PROJECTION_REGISTRY: Map<string, ProjectionDefinition>;
export type EpsgResolver = (epsg: number) => Promise<ProjectionDefinition>;
export declare function epsgResolver(epsg: number): Promise<ProjectionDefinition>;
//# sourceMappingURL=registry.d.ts.map