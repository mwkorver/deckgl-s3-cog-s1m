/**
 * Variable Matrix Width data structure
 */
export interface VariableMatrixWidth {
    /**
     * Number of tiles in width that coalesce in a single tile for these rows
     */
    coalesce: number;
    /**
     * First tile row where the coalescence factor applies for this tilematrix
     */
    minTileRow: number;
    /**
     * Last tile row where the coalescence factor applies for this tilematrix
     */
    maxTileRow: number;
    [k: string]: unknown;
}
//# sourceMappingURL=variableMatrixWidth.d.ts.map