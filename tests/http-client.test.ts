import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PancakeHttpClient } from "../src/api-client/pancake-http-client.js";

describe("PancakeHttpClient configurable options", () => {
  it("uses default timeout when no options provided", async () => {
    const { PancakeHttpClient } = await import(
      "../src/api-client/pancake-http-client.js"
    );
    const client = new PancakeHttpClient({
      PANCAKE_POS_API_KEY: "test",
      PANCAKE_POS_SHOP_ID: "test",
      PANCAKE_POS_BASE_URL: "https://api.test.com",
      PORT: 3000,
    });
    // Default timeout should be 30s
    expect((client as unknown as Record<string, number>).fetchTimeoutMs).toBe(30_000);
  });

  it("accepts custom timeout for Workers mode", async () => {
    const { PancakeHttpClient } = await import(
      "../src/api-client/pancake-http-client.js"
    );
    const client = new PancakeHttpClient(
      {
        PANCAKE_POS_API_KEY: "test",
        PANCAKE_POS_SHOP_ID: "test",
        PANCAKE_POS_BASE_URL: "https://api.test.com",
        PORT: 3000,
      },
      { fetchTimeoutMs: 8_000, maxAttempts: 2, enableRateLimiter: false },
    );
    expect((client as unknown as Record<string, number>).fetchTimeoutMs).toBe(8_000);
  });
});

describe("PancakeHttpClient 429 retry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries on 429 Too Many Requests", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("Too Many Requests", { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { id: 1 }, success: true }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const { PancakeHttpClient } = await import(
      "../src/api-client/pancake-http-client.js"
    );
    const client = new PancakeHttpClient(
      {
        PANCAKE_POS_API_KEY: "test",
        PANCAKE_POS_SHOP_ID: "test",
        PANCAKE_POS_BASE_URL: "https://api.test.com",
        PORT: 3000,
      },
      { enableRateLimiter: false },
    );

    const result = await client.get("/orders/1");
    expect(result.data).toEqual({ id: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("PancakeHttpClient attempt budget", () => {
  let originalFetch: typeof globalThis.fetch;
  const config = {
    PANCAKE_POS_API_KEY: "test",
    PANCAKE_POS_SHOP_ID: "test",
    PANCAKE_POS_BASE_URL: "https://api.test.com",
    PORT: 3000,
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maxAttempts: 0 still performs one real request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 1 }, success: true }), { status: 200 }),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
    const client = new PancakeHttpClient(config, { maxAttempts: 0, enableRateLimiter: false });

    const result = await client.get("/orders/1");
    expect(result.data).toEqual({ id: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("network failure on the only attempt surfaces the underlying error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
    const client = new PancakeHttpClient(config, { maxAttempts: 1, enableRateLimiter: false });

    await expect(client.get("/orders/1")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Failed after 1 attempts: ECONNRESET",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("Rate limiter control", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips rate limiter when enableRateLimiter is false", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { id: 1 }, success: true }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const { PancakeHttpClient } = await import(
      "../src/api-client/pancake-http-client.js"
    );
    const client = new PancakeHttpClient(
      {
        PANCAKE_POS_API_KEY: "test",
        PANCAKE_POS_SHOP_ID: "test",
        PANCAKE_POS_BASE_URL: "https://api.test.com",
        PORT: 3000,
      },
      { enableRateLimiter: false },
    );

    // Should execute immediately without rate limit delay
    const start = Date.now();
    await client.get("/orders/1");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200); // No rate limit wait
  });
});
