import { describe, expect, test } from "vitest";
import { parsePaginatedResponse, parseResponse } from "../../src/api-client/response-parser.js";
import { loadConfig } from "../../src/config.js";

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parsePaginatedResponse - aggs pass-through", () => {
  test("forwards aggs from API body", async () => {
    const r = await parsePaginatedResponse(
      makeResponse({
        data: [{ id: 1 }],
        success: true,
        page_number: 1,
        page_size: 1,
        total_entries: 100,
        total_pages: 100,
        aggs: {
          cod: { value: 4.55e8 },
          status: { buckets: [{ key: "0", doc_count: 50 }] },
        },
      }),
    );
    expect(r.aggs).toBeDefined();
    expect(r.aggs?.cod).toEqual({ value: 4.55e8 });
  });

  test("absent aggs → undefined", async () => {
    const r = await parsePaginatedResponse(
      makeResponse({
        data: [],
        success: true,
        page_number: 1,
        page_size: 30,
        total_entries: 0,
        total_pages: 0,
      }),
    );
    expect(r.aggs).toBeUndefined();
  });
});

describe("error mapping", () => {
  test("403 error_code 105 → INVALID_API_KEY with actionable hint", async () => {
    const err = await parseResponse(
      makeResponse({ message: "api_key is invalid", success: false, error_code: 105 }, 403),
    ).catch((e) => e);
    expect(err.code).toBe("INVALID_API_KEY");
    expect(err.httpStatus).toBe(403);
    expect(err.message).toMatch(/stray spaces/);
  });

  test("other 403 stays FORBIDDEN with raw body", async () => {
    const err = await parsePaginatedResponse(
      makeResponse({ message: "no permission", success: false }, 403),
    ).catch((e) => e);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toContain("no permission");
  });
});

describe("loadConfig credentials", () => {
  test("trims copy-paste whitespace from api key and shop id", () => {
    const cfg = loadConfig({ PANCAKE_POS_API_KEY: "  abc123\n", PANCAKE_POS_SHOP_ID: " 407195186 " });
    expect(cfg.PANCAKE_POS_API_KEY).toBe("abc123");
    expect(cfg.PANCAKE_POS_SHOP_ID).toBe("407195186");
  });
});
