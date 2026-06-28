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

interface MemoryEntry {
  bytes: ArrayBuffer;
  size: number;
}

class BrowserCacheStore implements ChunkCacheStore {
  private readonly cacheName: string;
  private readonly prefix: string;

  constructor(cacheName: string, cacheKey: string, chunkSize: number) {
    this.cacheName = cacheName;
    this.prefix = `${cacheKeyHash(cacheKey)}/${chunkSize}`;
  }

  private requestFor(key: string): Request {
    const origin =
      typeof globalThis.location?.origin === "string"
        ? globalThis.location.origin
        : "https://s3-cog.local";
    return new Request(
      `${origin}/__s3_cog_chunk_cache__/${this.prefix}/${encodeURIComponent(key)}`,
    );
  }

  private async cache(): Promise<Cache | undefined> {
    if (!globalThis.caches?.open) {
      return undefined;
    }
    return await globalThis.caches.open(this.cacheName);
  }

  async get(key: string): Promise<ArrayBuffer | undefined> {
    const cache = await this.cache();
    if (!cache) {
      return undefined;
    }
    const response = await cache.match(this.requestFor(key));
    return response ? await response.arrayBuffer() : undefined;
  }

  async put(key: string, value: ArrayBuffer): Promise<void> {
    const cache = await this.cache();
    if (!cache) {
      return;
    }
    await cache.put(
      this.requestFor(key),
      new Response(value, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-s3-cog-chunk-cache": "1",
        },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    const cache = await this.cache();
    if (!cache) {
      return;
    }
    await cache.delete(this.requestFor(key));
  }
}

function cacheKeyHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cloneArrayBuffer(input: ArrayBuffer): ArrayBuffer {
  return input.slice(0);
}

function checkedChunkSize(value: number | undefined): number {
  const chunkSize = value ?? 1024 * 1024;
  if (!Number.isFinite(chunkSize) || chunkSize <= 0 || !Number.isInteger(chunkSize)) {
    throw new Error("chunkSize must be a positive integer");
  }
  return chunkSize;
}

function checkedLength(length: number | undefined): number {
  if (length === undefined) {
    throw new Error("ChunkCachedSource.fetch requires an explicit length");
  }
  if (!Number.isFinite(length) || length < 0 || !Number.isInteger(length)) {
    throw new Error("length must be a non-negative integer");
  }
  return length;
}

export class ChunkCachedSource implements Source {
  private readonly source: Source;
  private readonly cacheKey: string;
  private readonly chunkSize: number;
  private readonly store: ChunkCacheStore | null;
  private readonly memoryMaxBytes: number;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inflight = new Map<string, Promise<ArrayBuffer>>();
  private memoryBytes = 0;
  private readonly counters: Omit<
    ChunkCacheStats,
    "memoryBytes" | "memoryMaxBytes" | "memoryEntries" | "inflight" | "chunkSize"
  > = {
    memoryHits: 0,
    persistentHits: 0,
    misses: 0,
    networkBytes: 0,
    requestedBytes: 0,
  };

  constructor(source: Source, opts: ChunkCachedSourceOptions) {
    this.source = source;
    this.cacheKey = opts.cacheKey;
    this.chunkSize = checkedChunkSize(opts.chunkSize);
    this.memoryMaxBytes = Math.max(0, opts.memoryMaxBytes ?? 64 * 1024 * 1024);
    this.store =
      opts.store === undefined
        ? new BrowserCacheStore(
            opts.cacheName ?? "cog-byte-chunks-v1",
            opts.cacheKey,
            this.chunkSize,
          )
        : opts.store;
  }

  get type(): string {
    return this.source.type;
  }

  get url(): URL {
    return this.source.url;
  }

  get metadata(): SourceMetadata | undefined {
    return this.source.metadata;
  }

  head(options?: { signal: AbortSignal }): Promise<SourceMetadata> {
    return this.source.head(options);
  }

  stats(): ChunkCacheStats {
    return {
      ...this.counters,
      memoryBytes: this.memoryBytes,
      memoryMaxBytes: this.memoryMaxBytes,
      memoryEntries: this.memory.size,
      inflight: this.inflight.size,
      chunkSize: this.chunkSize,
    };
  }

  clearMemory(): void {
    this.memory.clear();
    this.memoryBytes = 0;
  }

  async fetch(
    offset: number,
    length?: number,
    options?: { signal: AbortSignal },
  ): Promise<ArrayBuffer> {
    const byteLength = checkedLength(length);
    if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
      throw new Error("offset must be a non-negative integer");
    }
    if (options?.signal?.aborted) {
      throw options.signal.reason;
    }
    this.counters.requestedBytes += byteLength;
    if (byteLength === 0) {
      return new ArrayBuffer(0);
    }

    const firstChunk = Math.floor(offset / this.chunkSize);
    const lastChunk = Math.floor((offset + byteLength - 1) / this.chunkSize);
    const chunks: ArrayBuffer[] = [];
    for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
      chunks.push(await this.fetchChunk(chunkIndex, options));
    }
    return this.assemble(chunks, offset, byteLength, firstChunk);
  }

  private chunkKey(chunkIndex: number): string {
    return `${this.cacheKey}:${this.chunkSize}:${chunkIndex}`;
  }

  private memoryGet(key: string): ArrayBuffer | undefined {
    const entry = this.memory.get(key);
    if (!entry) {
      return undefined;
    }
    this.memory.delete(key);
    this.memory.set(key, entry);
    return cloneArrayBuffer(entry.bytes);
  }

  private memoryPut(key: string, value: ArrayBuffer): void {
    if (this.memoryMaxBytes <= 0 || value.byteLength > this.memoryMaxBytes) {
      return;
    }
    const existing = this.memory.get(key);
    if (existing) {
      this.memoryBytes -= existing.size;
      this.memory.delete(key);
    }
    this.memory.set(key, { bytes: cloneArrayBuffer(value), size: value.byteLength });
    this.memoryBytes += value.byteLength;
    while (this.memoryBytes > this.memoryMaxBytes) {
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.memory.get(oldestKey);
      this.memory.delete(oldestKey);
      this.memoryBytes -= oldest?.size ?? 0;
    }
  }

  private async fetchChunk(
    chunkIndex: number,
    options?: { signal: AbortSignal },
  ): Promise<ArrayBuffer> {
    const key = this.chunkKey(chunkIndex);
    const memoryHit = this.memoryGet(key);
    if (memoryHit) {
      this.counters.memoryHits += 1;
      return memoryHit;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return cloneArrayBuffer(await pending);
    }

    const fetchPromise = this.fetchChunkUncached(chunkIndex, key, options)
      .then((bytes) => {
        this.memoryPut(key, bytes);
        return bytes;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, fetchPromise);
    return cloneArrayBuffer(await fetchPromise);
  }

  private async fetchChunkUncached(
    chunkIndex: number,
    key: string,
    options?: { signal: AbortSignal },
  ): Promise<ArrayBuffer> {
    const stored = await this.store?.get(key);
    if (stored) {
      this.counters.persistentHits += 1;
      return stored;
    }

    this.counters.misses += 1;
    const offset = chunkIndex * this.chunkSize;
    const bytes = await this.source.fetch(offset, this.chunkSize, options);
    this.counters.networkBytes += bytes.byteLength;
    await this.store?.put(key, bytes);
    return bytes;
  }

  private assemble(
    chunks: ArrayBuffer[],
    offset: number,
    length: number,
    firstChunk: number,
  ): ArrayBuffer {
    const out = new Uint8Array(length);
    let written = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = new Uint8Array(chunks[i]!);
      const chunkIndex = firstChunk + i;
      const chunkStart = chunkIndex * this.chunkSize;
      const from = Math.max(0, offset - chunkStart);
      const to = Math.min(chunk.byteLength, offset + length - chunkStart);
      if (to <= from) {
        continue;
      }
      out.set(chunk.subarray(from, to), written);
      written += to - from;
    }
    return out.buffer;
  }
}
