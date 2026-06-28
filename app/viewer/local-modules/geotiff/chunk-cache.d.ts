import type { Source, SourceMetadata } from "@chunkd/source";
export interface ChunkCacheStore {
    get(key: string): Promise<ArrayBuffer | undefined>;
    put(key: string, value: ArrayBuffer): Promise<void>;
    delete?(key: string): Promise<void>;
}
export interface ChunkCacheStats {
    memoryHits: number;
    persistentHits: number;
    misses: number;
    networkBytes: number;
    requestedBytes: number;
    memoryBytes: number;
    memoryMaxBytes: number;
    memoryEntries: number;
    inflight: number;
    chunkSize: number;
}
export interface ChunkCachedSourceOptions {
    /** Stable source identity. Use s3://bucket/key, not a rotating signed URL. */
    cacheKey: string;
    /** Fixed normalized byte chunk size. Defaults to 1 MiB. */
    chunkSize?: number;
    /** Persistent browser Cache API name. Defaults to cog-byte-chunks-v1. */
    cacheName?: string;
    /** Optional test/custom persistent store. Defaults to browser Cache API. */
    store?: ChunkCacheStore | null;
    /** In-memory LRU cap. Defaults to 64 MiB. Set 0 to disable. */
    memoryMaxBytes?: number;
}
export declare class ChunkCachedSource implements Source {
    private readonly source;
    private readonly cacheKey;
    private readonly chunkSize;
    private readonly store;
    private readonly memoryMaxBytes;
    private readonly memory;
    private readonly inflight;
    private memoryBytes;
    private readonly counters;
    constructor(source: Source, opts: ChunkCachedSourceOptions);
    get type(): string;
    get url(): URL;
    get metadata(): SourceMetadata | undefined;
    head(options?: {
        signal: AbortSignal;
    }): Promise<SourceMetadata>;
    stats(): ChunkCacheStats;
    clearMemory(): void;
    fetch(offset: number, length?: number, options?: {
        signal: AbortSignal;
    }): Promise<ArrayBuffer>;
    private chunkKey;
    private memoryGet;
    private memoryPut;
    private fetchChunk;
    private fetchChunkUncached;
    private assemble;
}
//# sourceMappingURL=chunk-cache.d.ts.map
