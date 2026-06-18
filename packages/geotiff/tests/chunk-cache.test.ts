import type { Source, SourceMetadata } from "@chunkd/source";
import { describe, expect, it } from "vitest";
import { ChunkCachedSource, type ChunkCacheStore } from "../src/chunk-cache.js";

class RecordingSource implements Source {
  readonly type = "recording";
  readonly url = new URL("https://example.test/cog.tif");
  readonly metadata: SourceMetadata = { size: Number.POSITIVE_INFINITY };
  readonly fetches: { offset: number; length: number }[] = [];
  delayTicks = 0;

  constructor(private readonly bytes: Uint8Array) {}

  async head(): Promise<SourceMetadata> {
    return this.metadata;
  }

  async fetch(offset: number, length?: number): Promise<ArrayBuffer> {
    const byteLength = length ?? this.bytes.byteLength - offset;
    this.fetches.push({ offset, length: byteLength });
    for (let i = 0; i < this.delayTicks; i++) {
      await Promise.resolve();
    }
    const slice = this.bytes.slice(offset, offset + byteLength);
    return slice.buffer.slice(
      slice.byteOffset,
      slice.byteOffset + slice.byteLength,
    ) as ArrayBuffer;
  }
}

class MemoryStore implements ChunkCacheStore {
  readonly values = new Map<string, ArrayBuffer>();
  gets = 0;
  puts = 0;

  async get(key: string): Promise<ArrayBuffer | undefined> {
    this.gets += 1;
    const value = this.values.get(key);
    return value ? value.slice(0) : undefined;
  }

  async put(key: string, value: ArrayBuffer): Promise<void> {
    this.puts += 1;
    this.values.set(key, value.slice(0));
  }
}

function makeBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i++) {
    out[i] = i & 0xff;
  }
  return out;
}

function expectBytes(actual: ArrayBuffer, expected: Uint8Array): void {
  expect(Array.from(new Uint8Array(actual))).toEqual(Array.from(expected));
}

describe("ChunkCachedSource", () => {
  it("fetches and slices a single normalized chunk", async () => {
    const source = new RecordingSource(makeBytes(512));
    const cached = new ChunkCachedSource(source, {
      cacheKey: "s3://bucket/key.tif",
      chunkSize: 128,
      store: null,
    });

    const result = await cached.fetch(10, 20);

    expectBytes(result, makeBytes(512).slice(10, 30));
    expect(source.fetches).toEqual([{ offset: 0, length: 128 }]);
    expect(cached.stats()).toMatchObject({
      memoryHits: 0,
      persistentHits: 0,
      misses: 1,
      networkBytes: 128,
      requestedBytes: 20,
    });
  });

  it("assembles requests spanning multiple chunks", async () => {
    const bytes = makeBytes(512);
    const source = new RecordingSource(bytes);
    const cached = new ChunkCachedSource(source, {
      cacheKey: "s3://bucket/key.tif",
      chunkSize: 128,
      store: null,
    });

    const result = await cached.fetch(120, 40);

    expectBytes(result, bytes.slice(120, 160));
    expect(source.fetches).toEqual([
      { offset: 0, length: 128 },
      { offset: 128, length: 128 },
    ]);
  });

  it("reuses memory chunks for overlapping reads", async () => {
    const bytes = makeBytes(512);
    const source = new RecordingSource(bytes);
    const cached = new ChunkCachedSource(source, {
      cacheKey: "s3://bucket/key.tif",
      chunkSize: 128,
      store: null,
    });

    expectBytes(await cached.fetch(10, 20), bytes.slice(10, 30));
    expectBytes(await cached.fetch(50, 10), bytes.slice(50, 60));

    expect(source.fetches).toEqual([{ offset: 0, length: 128 }]);
    expect(cached.stats().memoryHits).toBe(1);
  });

  it("reuses persistent chunks across source instances", async () => {
    const bytes = makeBytes(512);
    const store = new MemoryStore();
    const firstSource = new RecordingSource(bytes);
    const first = new ChunkCachedSource(firstSource, {
      cacheKey: "s3://bucket/key.tif",
      chunkSize: 128,
      store,
    });
    await first.fetch(10, 20);

    const secondSource = new RecordingSource(bytes);
    const second = new ChunkCachedSource(secondSource, {
      cacheKey: "s3://bucket/key.tif",
      chunkSize: 128,
      store,
    });
    expectBytes(await second.fetch(50, 10), bytes.slice(50, 60));

    expect(firstSource.fetches).toEqual([{ offset: 0, length: 128 }]);
    expect(secondSource.fetches).toEqual([]);
    expect(second.stats().persistentHits).toBe(1);
    expect(store.puts).toBe(1);
  });

  it("de-dupes concurrent overlapping chunk misses", async () => {
    const bytes = makeBytes(512);
    const source = new RecordingSource(bytes);
    source.delayTicks = 3;
    const cached = new ChunkCachedSource(source, {
      cacheKey: "s3://bucket/key.tif",
      chunkSize: 128,
      store: null,
    });

    const [a, b] = await Promise.all([
      cached.fetch(10, 20),
      cached.fetch(50, 10),
    ]);

    expectBytes(a, bytes.slice(10, 30));
    expectBytes(b, bytes.slice(50, 60));
    expect(source.fetches).toEqual([{ offset: 0, length: 128 }]);
  });
});
