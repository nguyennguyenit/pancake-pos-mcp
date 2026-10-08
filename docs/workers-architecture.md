# Cloudflare Workers Deployment Architecture

> Extracted from `system-architecture.md` to keep that file under the 800-LOC budget.
> Operational deployment steps live in [`deployment-guide.md`](./deployment-guide.md); this doc covers the **architecture** (per-request lifecycle, tuning, CORS/auth design).

## Request Handling (Per-Request Lifecycle)

Unlike Bun/HTTP server (persistent server), Cloudflare Workers creates a fresh MCP server + transport **per incoming request**:

```
Client Request
  ↓
  Cloudflare Workers fetch handler (src/worker.ts)
  ├─ Load config from env variables (cached across requests)
  ├─ Get or create HTTP client (cached, reused across requests)
  ├─ Auth verification (timing-safe token comparison)
  ├─ Create fresh MCP server instance
  ├─ Create fresh transport instance
  ├─ Handle request
  ├─ Add CORS headers
  └─ Return response
  ↓
Client Response
```

**Key Design:**
- **Config + Client:** Cached at module level (reused across requests)
- **Server + Transport:** Fresh per request (required by MCP SDK stateless behavior)
- **Timeout:** 8 seconds (vs 30s in Bun mode, constrained by Workers)
- **Rate Limiter:** Disabled (per-request mode incompatible with stateful token bucket)
- **Retries:** Reduced to 2 attempts (vs 3 in Bun mode, to fit within timeout)

## Configuration (wrangler.toml)

```toml
name = "pancake-pos-mcp"
main = "src/worker.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

[vars]
PANCAKE_POS_API_KEY = "placeholder-set-via-wrangler-secret"
PANCAKE_POS_SHOP_ID = "placeholder-set-via-wrangler-secret"
PANCAKE_POS_BASE_URL = "https://pos.pages.fm/api/v1"
```

Secrets are managed separately:
```bash
wrangler secret put PANCAKE_POS_API_KEY
wrangler secret put PANCAKE_POS_SHOP_ID
wrangler secret put MCP_AUTH_TOKEN  # optional, for Bearer token auth
```

## HTTP Client Tuning (Workers Mode)

The `HttpClientOptions` interface allows mode-specific tuning:

```typescript
interface HttpClientOptions {
  /** Fetch timeout in milliseconds (default: 30s, Workers: 8s) */
  fetchTimeoutMs?: number;

  /** Total attempts incl. first call (default: 3, Workers: 2, min 1) */
  maxAttempts?: number;

  /** Enable token-bucket rate limiter (default: true, Workers: false) */
  enableRateLimiter?: boolean;
}
```

**Workers Initialization:**
```typescript
new PancakeHttpClient(config, {
  fetchTimeoutMs: 8_000,      // Cloudflare timeout
  maxAttempts: 2,             // Reduced for stateless mode
  enableRateLimiter: false,   // Disabled (no state across requests)
})
```

## CORS & Auth

Workers fetch handler includes built-in:
- **CORS Support:** Preflight (OPTIONS) + headers on all responses
- **Timing-Safe Auth:** Bearer token verification using `crypto.subtle.timingSafeEqual`
- **Health Endpoint:** `/health` (no auth required)

```typescript
// Auth required if MCP_AUTH_TOKEN is set in env
const authToken = config.MCP_AUTH_TOKEN;
if (authToken) {
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
```

## Endpoints

| Path | Auth | Purpose |
|------|------|---------|
| `GET /health` | No | Health check |
| `POST /mcp` | Yes* | MCP protocol endpoint |
| `OPTIONS /*` | No | CORS preflight |

*Auth required only if `MCP_AUTH_TOKEN` is set.

## Advantages Over Bun/HTTP
- **Automatic Scaling:** Global edge network, no infrastructure management
- **Lower Latency:** CDN-adjacent deployment worldwide
- **Cost-Efficient:** Pay-per-request, no idle cost
- **Easy Deployment:** `wrangler deploy` (single command)

## Tradeoffs
- **Shorter Timeout:** 8s vs 30s (Pancake API must respond quickly)
- **No Rate Limiter:** Handled per-request, not across lifetime
- **Reduced Retries:** 2 attempts vs 3 to fit timeout
- **No Session State:** Fresh server per request (minor overhead, but stateless by design)
