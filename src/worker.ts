import { loadConfig } from "./config.js";
import { PancakeHttpClient } from "./api-client/pancake-http-client.js";
import type { PancakeConfig } from "./config.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
} as const;

/**
 * Timing-safe comparison for Bearer tokens.
 * Prevents timing side-channel attacks on token verification.
 */
async function verifyToken(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Creates a fresh MCP server + transport per request.
 * Required because WebStandardStreamableHTTPServerTransport rejects
 * re-initialization in stateful mode and throws on reuse in stateless mode.
 */
async function createPerRequestMcp(client: PancakeHttpClient) {
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );
  const { createServer } = await import("./server.js");

  const server = createServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking
    enableJsonResponse: true, // return JSON, not SSE
  });

  await server.connect(transport);
  return transport;
}

// Lazy init: config + client created on first request, cached for reuse
let cachedConfig: PancakeConfig | undefined;
let cachedClient: PancakeHttpClient | undefined;

function getClient(
  env: Record<string, unknown>,
): { config: PancakeConfig; client: PancakeHttpClient } {
  if (!cachedConfig || !cachedClient) {
    cachedConfig = loadConfig(env);
    // Workers-optimized: 8s timeout, 2 attempts, no rate limiter (stateless per-request)
    cachedClient = new PancakeHttpClient(cachedConfig, {
      fetchTimeoutMs: 8_000,
      maxAttempts: 2,
      enableRateLimiter: false,
    });
  }
  return { config: cachedConfig, client: cachedClient };
}

export default {
  async fetch(
    req: Request,
    env: Record<string, unknown>,
  ): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check — no auth required
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", transport: "streamable-http" }),
        {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        },
      );
    }

    // MCP endpoint — auth + per-request transport
    if (url.pathname === "/mcp") {
      const { config, client } = getClient(env);

      // Auth enforcement
      const authToken = config.MCP_AUTH_TOKEN;
      if (authToken) {
        const authHeader = req.headers.get("authorization");
        const token = authHeader?.startsWith("Bearer ")
          ? authHeader.slice(7)
          : "";
        if (!token || !(await verifyToken(token, authToken))) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }
      }

      // Create fresh MCP server + transport per request (C1 fix)
      const transport = await createPerRequestMcp(client);
      const response = await transport.handleRequest(req);

      // Add CORS headers to transport response
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        newHeaders.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
