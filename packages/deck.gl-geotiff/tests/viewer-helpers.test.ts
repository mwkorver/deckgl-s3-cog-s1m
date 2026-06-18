import { describe, expect, it, vi } from "vitest";

// ============================================================================
// Implementation of viewer helpers to test (copied/adapted from viewer/index.html)
// ============================================================================

interface Collection {
  id: string;
  bucket: string;
  access: "public" | "requester-pays";
}

function collectionForHref(s3href: string, collections: Collection[]): Collection | null {
  const m = /^s3:\/\/([^/]+)\//.exec(s3href || "");
  if (!m) return null;
  return collections.find((p) => p.bucket === m[1]) || null;
}

function isExpiredSignatureError(error: any): boolean {
  for (let e = error; e; e = e.cause) {
    const msg = String(e?.message || "");
    if (msg.includes("403") || /expired/i.test(msg) || /accessdenied/i.test(msg)) {
      return true;
    }
  }
  return false;
}

function isAbortLikeError(error: any): boolean {
  for (let e = error; e; e = e.cause) {
    if (e?.name === "AbortError" || e?.message?.includes("abort")) {
      return true;
    }
  }
  return false;
}

class LazySigningManager {
  public signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
  public inflightSigns = new Map<string, Promise<string>>();

  constructor(
    private apiFetchMock: (path: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>
  ) {}

  async signHref(s3href: string, collections: Collection[]): Promise<string> {
    if (!s3href || !s3href.startsWith("s3://")) return s3href;

    const owner = collectionForHref(s3href, collections);
    if (owner && owner.access === "public") {
      const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3href);
      if (m) {
        return `https://${m[1]}.s3.amazonaws.com/${m[2]}`;
      }
      return s3href;
    }

    const now = Date.now();
    const cached = this.signedUrlCache.get(s3href);
    if (cached && cached.expiresAt > now) return cached.url;

    let pending = this.inflightSigns.get(s3href);
    if (!pending) {
      pending = this.apiFetchMock(`/sign?href=${encodeURIComponent(s3href)}`)
        .then(async (resp) => {
          if (!resp.ok) throw new Error(`sign failed: ${resp.status}`);
          const data = await resp.json();
          const ttlMs = Math.max(0, (Number(data.expires_in) || 0) * 1000 - 60000);
          this.signedUrlCache.set(s3href, {
            url: data.signed,
            expiresAt: ttlMs ? now + ttlMs : now + 60000,
          });
          return data.signed;
        })
        .finally(() => this.inflightSigns.delete(s3href));
      this.inflightSigns.set(s3href, pending);
    }
    return pending;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Viewer Helpers", () => {
  const collections: Collection[] = [
    { id: "naip", bucket: "naip-analytic", access: "requester-pays" },
    { id: "kyfromabove", bucket: "kyfromabove", access: "public" },
  ];

  describe("collectionForHref", () => {
    it("matches href to correct collection based on bucket", () => {
      const href = "s3://kyfromabove/imagery/orthos/Phase2/tile.tif";
      const match = collectionForHref(href, collections);
      expect(match).not.toBeNull();
      expect(match?.id).toBe("kyfromabove");
      expect(match?.access).toBe("public");
    });

    it("returns null for untracked buckets", () => {
      const href = "s3://some-untracked-bucket/tile.tif";
      expect(collectionForHref(href, collections)).toBeNull();
    });

    it("returns null for non-s3 hrefs", () => {
      expect(collectionForHref("https://example.com/tile.tif", collections)).toBeNull();
    });
  });

  describe("isExpiredSignatureError", () => {
    it("detects expired error in message", () => {
      const err = new Error("Request failed with status code 403: SignatureExpired");
      expect(isExpiredSignatureError(err)).toBe(true);
    });

    it("detects expired error deep in cause chain", () => {
      const rootCause = new Error("AccessDenied: AWS credentials expired");
      const middleErr = new Error("Failed fetching range", { cause: rootCause });
      const topErr = new Error("Failed loading GeoTIFF", { cause: middleErr });
      expect(isExpiredSignatureError(topErr)).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      const err = new Error("Network connection lost");
      expect(isExpiredSignatureError(err)).toBe(false);
    });
  });

  describe("isAbortLikeError", () => {
    it("detects AbortError by name", () => {
      const err = new Error("Request was cancelled");
      err.name = "AbortError";
      expect(isAbortLikeError(err)).toBe(true);
    });

    it("detects abort keyword in message", () => {
      const err = new Error("The user aborted a request.");
      expect(isAbortLikeError(err)).toBe(true);
    });

    it("detects abort deep in cause chain", () => {
      const abortErr = new Error("Request aborted");
      abortErr.name = "AbortError";
      const topErr = new Error("Failed loading tile", { cause: abortErr });
      expect(isAbortLikeError(topErr)).toBe(true);
    });
  });

  describe("LazySigningManager", () => {
    it("returns public https urls directly without calling api sign", async () => {
      const apiFetchMock = vi.fn();
      const manager = new LazySigningManager(apiFetchMock);

      const href = "s3://kyfromabove/imagery/orthos/Phase2/tile.tif";
      const url = await manager.signHref(href, collections);

      expect(url).toBe("https://kyfromabove.s3.amazonaws.com/imagery/orthos/Phase2/tile.tif");
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it("calls API /sign and caches result for requester-pays bucket", async () => {
      const mockSignResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          href: "s3://naip-analytic/tile.tif",
          signed: "https://naip-analytic.s3.amazonaws.com/tile.tif?AWSAccessKeyId=123",
          expires_in: 3600,
        }),
      };
      const apiFetchMock = vi.fn().mockResolvedValue(mockSignResponse);
      const manager = new LazySigningManager(apiFetchMock);

      const href = "s3://naip-analytic/tile.tif";
      const url = await manager.signHref(href, collections);

      expect(url).toContain("AWSAccessKeyId=123");
      expect(apiFetchMock).toHaveBeenCalledTimes(1);

      // Subsequent call should hit cache and not fetch API again
      const url2 = await manager.signHref(href, collections);
      expect(url2).toBe(url);
      expect(apiFetchMock).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent signing requests for the same href", async () => {
      let resolveFetch: any;
      const fetchPromise = new Promise<any>((resolve) => {
        resolveFetch = resolve;
      });

      const apiFetchMock = vi.fn().mockImplementation(() => fetchPromise);
      const manager = new LazySigningManager(apiFetchMock);
      const href = "s3://naip-analytic/tile.tif";

      // Fire multiple requests concurrently
      const promise1 = manager.signHref(href, collections);
      const promise2 = manager.signHref(href, collections);

      // Resolve the fetch
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({
          href,
          signed: "https://signed-url",
          expires_in: 3600,
        }),
      });

      const [url1, url2] = await Promise.all([promise1, promise2]);
      expect(url1).toBe("https://signed-url");
      expect(url2).toBe("https://signed-url");
      expect(apiFetchMock).toHaveBeenCalledTimes(1); // Only 1 fetch made
    });
  });
});
