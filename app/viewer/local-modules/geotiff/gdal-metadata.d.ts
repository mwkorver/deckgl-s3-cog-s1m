export type BandStatistics = {
    max: number | null;
    min: number | null;
    mean: number | null;
    std: number | null;
    validPercent: number | null;
};
export type GDALMetadata = {
    /** Mapping of 1-based band index to statistics. */
    bandStatistics: Map<number, BandStatistics>;
    offsets: number[];
    scales: number[];
};
export declare function parseGDALMetadata(gdalMetadata: string | null | undefined, { count }: {
    count: number;
}): GDALMetadata | null;
//# sourceMappingURL=gdal-metadata.d.ts.map