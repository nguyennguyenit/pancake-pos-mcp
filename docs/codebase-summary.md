# Pancake POS MCP - Codebase Summary

**Version:** 0.1.0  
**Status:** Complete (Phases 1-5 implemented + Cloudflare Workers deployment)  
**Technology Stack:** Bun + TypeScript + MCP SDK v1.29.0 + Wrangler

---

## Executive Overview

The Pancake POS MCP server is a Model Context Protocol implementation that wraps the Pancake POS REST API with **24 specialized tools** organized in 5 development phases. The server provides both **stdio** and **Streamable HTTP** transport options, making it compatible with Claude and other AI assistants for POS management automation.

### Key Metrics
- **24 MCP Tools** across 5 business domains (Phase 5 + analytics wrapper)
- **7 Static Reference Resources** (order statuses, shipping partners, webhook events, etc.)
- **Rate Limiting:** 1,000 requests/minute, 10,000 requests/hour (token-bucket algorithm)
- **Retry Strategy:** 3 attempts with exponential backoff (1s → 2s → 4s)
- **Transport:** stdio (default) + Streamable HTTP
- **Authentication:** Pancake API key + shop ID injection (transparent to tools)

---

## Project Structure

```
src/
├── api-client/              # HTTP layer with rate limiting & retries
│   ├── pancake-http-client.ts      # Main HTTP client (token-bucket, exponential backoff)
│   ├── request-builder.ts           # URL construction with path encoding
│   └── response-parser.ts           # Response parsing & error handling
├── tools/                   # 24 MCP tools organized by phase
│   ├── Phase 1 (Core POS)
│   │   ├── orders-tool.ts           # Order CRUD + print/ship/call_later
│   │   ├── products-tool.ts         # Product CRUD + variations
│   │   ├── customers-tool.ts        # Customer CRUD + reward history
│   │   └── inventory-tool.ts        # Inventory reports by warehouse/category
│   ├── Phase 2 (Supply Chain)
│   │   ├── warehouses-tool.ts       # Warehouse CRUD
│   │   ├── suppliers-tool.ts        # Supplier CRUD
│   │   ├── purchases-tool.ts        # Purchase orders (inbound stock)
│   │   ├── transfers-tool.ts        # Warehouse-to-warehouse transfers
│   │   └── stocktaking-tool.ts      # Physical inventory counts
│   ├── Phase 3 (Sales Extensions)
│   │   ├── returns-tool.ts          # Order returns & exchanges
│   │   ├── combos-tool.ts           # Product bundle deals
│   │   ├── promotions-tool.ts       # Discount campaigns
│   │   └── vouchers-tool.ts         # Voucher code management
│   ├── Phase 4 (CRM & Multi-Channel)
│   │   ├── crm-contacts-tool.ts     # CRM contact CRUD
│   │   ├── crm-deals-tool.ts        # Sales pipeline opportunities
│   │   ├── crm-activities-tool.ts   # Calls, meetings, tasks, notes
│   │   ├── ecommerce-tool.ts        # Shopee/Lazada/TikTok sync
│   │   └── livestream-tool.ts       # Live selling sessions
│   ├── Phase 5 (Operations)
│   │   ├── employees-tool.ts        # Staff management
│   │   ├── webhooks-tool.ts         # Event subscription management
│   │   ├── statistics-tool.ts       # Analytics (inventory/sales/orders)
│   │   ├── shop-info-tool.ts        # Shop profile get/update
│   │   ├── address-lookup-tool.ts   # Vietnamese address hierarchy
│   │   └── analytics-tool.ts        # Analytics wrapper (top_orders, revenue_summary) + aggs extraction
│   └── tool-registry.ts             # Registers all 24 tools with MCP server
├── resources/               # Static reference data as MCP Resources
│   ├── reference-data-resources.ts  # Data definitions (order statuses, error codes, etc.)
│   └── resource-registry.ts         # Registers 7 resources
├── shared/                  # Shared utilities
│   ├── schemas.ts                   # Zod type definitions (PancakeAggregations, VietnamAddressSchema, etc.)
│   ├── sort-options.ts              # ORDER_SORT_VALUES enum (18 values) + analytics sort mapping
│   ├── error-handler.ts             # PancakeApiError + formatToolError
│   └── pagination-helpers.ts        # Pagination result formatting (forwards aggs field)
├── config.ts                # Configuration (BASE_URL, API_KEY, SHOP_ID)
├── server.ts                # MCP server factory function
├── index.ts                 # Entry point (Bun: stdio + HTTP bootstrap)
└── worker.ts                # Entry point (Cloudflare Workers fetch handler)
```

**Deployment Models:**
The codebase supports two independent deployment entry points:
- **index.ts:** Primary entry point for traditional server deployment (Bun runtime). Supports stdio transport (Claude Desktop) or Streamable HTTP transport (remote access). Full rate limiter with 30s timeout and 3 retries.
- **worker.ts:** Alternative entry point for serverless Cloudflare Workers deployment. Fresh MCP server per request, 8s timeout, 2 retries, rate limiter disabled. Same tool/resource implementations as index.ts, differing only in transport and environment tuning.

Both entry points reuse the identical HTTP client, tool registry, and resource definitions; configuration and deployment mode selection determines which is used.
```

---

## Architecture Decisions

### 1. Two-Level Tool Schema Pattern
Each tool uses **two schemas for compatibility**:
- **Discriminated Union Schema** (Zod): Strict runtime validation with exact type checking
- **Flat Raw Schema** (MCP registration): Compatible with JSON Schema generation

Example pattern (seen in all 24 tools):
```typescript
// Handler receives discriminated union (strict runtime validation)
const parsed = ordersToolSchema.parse(args);

// Registry uses flat raw shape for MCP JSON Schema
server.tool("manage_orders", "...", {
  action: z.enum([...]),
  order_id: z.number().int().optional(),
  // ... all possible params flattened
})
```

**Rationale:** MCP SDK requires flat JSON Schema; Zod's discriminated union ensures we catch invalid action+param combinations at runtime.

### 2. Token-Bucket Rate Limiter (Dual Tier)
Pancake API has two rate limits:
- **Per-minute:** 1,000 requests/minute
- **Per-hour:** 10,000 requests/hour

Implementation in `pancake-http-client.ts`:
```typescript
// Minute bucket: 1 token every 60ms = 1000/min
private minuteTokens = 1000;
private readonly minuteRefillRateMs = 60;

// Hour bucket: 1 token every 360ms = 10000/hour  
private hourTokens = 10000;
private readonly hourRefillRateMs = 360;

// Both checked; request waits if EITHER limit would be exceeded
await this.consumeToken();
```

**Rationale:** Ensures predictable behavior; prevents sudden spike-based rate limit violations.

### 3. Exponential Backoff Retry (Configurable: 2-3 Attempts)
Only retries on server errors (5xx status codes):
```typescript
if (response.status >= 500 && attempt < maxAttempts - 1) {
  const delay = RETRY_BASE_MS * Math.pow(2, attempt); // 1s → 2s → 4s
  await sleep(delay);
}
```

**Default (Bun mode):** 3 attempts, 30s timeout, rate limiter enabled
**Workers mode:** 2 attempts, 8s timeout, rate limiter disabled

**Rationale:** Avoids overwhelming a degraded backend; configurable retry budget balances resilience vs. latency based on deployment environment.

### 3.5. Deployment-Specific HTTP Client Configuration

The `HttpClientOptions` interface enables environment-specific tuning:

```typescript
export interface HttpClientOptions {
  fetchTimeoutMs?: number;      // Fetch timeout (default: 30000ms)
  maxAttempts?: number;         // Total attempts incl. first call (default: 3, min 1)
  enableRateLimiter?: boolean;  // Token bucket (default: true)
}
```

**Bun/HTTP Server Mode:**
```typescript
new PancakeHttpClient(config)  // All defaults: 30s, 3 attempts, rate limiting
```

**Cloudflare Workers Mode:**
```typescript
new PancakeHttpClient(config, {
  fetchTimeoutMs: 8_000,        // 8s (Cloudflare constraint)
  maxAttempts: 2,               // Reduced for timeout budget
  enableRateLimiter: false,     // Per-request mode incompatible with stateful bucket
})
```

**Rationale:** Per-request Workers architecture cannot maintain persistent rate limiter state; Bun server maintains rate limiting across lifetime.

### 4. URL Path Security with Encoding
`request-builder.ts` constructs paths with **path segment encoding** to prevent traversal attacks:
```typescript
buildRequestUrl(baseUrl, shopId, apiKey, path, params)
// Encodes: shop UUID, path segments, query parameters
// Global prefixes bypass shop scope: ["/partners", "address"]
```

**Known Risk:** Path segments must be validated at call site (ID validation); see `code-standards.md` for UUID pattern enforcement.

### 5. 7 Static Reference Resources
Registered as MCP Resources for quick lookup without API calls:

| Resource | Purpose |
|----------|---------|
| `order-statuses` | Status codes (1=pending, 2=completed, etc.) |
| `order-sources` | Channel codes (Facebook, Shopee, Lazada, etc.) |
| `sort-options` | Available order sort fields |
| `webhook-events` | Event type strings |
| `error-codes` | HTTP error meanings |
| `rate-limits` | Documented limits (1000/min, 10000/hr) |
| `shipping-partners` | Fetched dynamically from API |

All resources exposed under `pancake://reference/*` URI scheme.

### 6. Error Handling Strategy
Custom `PancakeApiError` class with typed error codes:
```typescript
throw new PancakeApiError("API_ERROR", message, statusCode);
```

Tool handlers wrap results in `formatToolError()`, which MCP SDK parses as tool error response.

---

## Key Files by Responsibility

### HTTP Client & Request Layer
| File | Lines | Responsibility |
|------|-------|-----------------|
| `api-client/pancake-http-client.ts` | ~150 | Rate limiting, retries, fetch orchestration |
| `api-client/request-builder.ts` | ~73 | URL construction, bracket-style array params, path encoding, auth injection |
| `api-client/response-parser.ts` | ~73 | JSON parsing, error detection, pagination + aggs forwarding |

### MCP Integration
| File | Lines | Responsibility |
|------|-------|-----------------|
| `tools/tool-registry.ts` | ~670 | Registers all 24 tools; core MCP integration |
| `resources/resource-registry.ts` | ~110 | Registers 7 static/dynamic resources |
| `server.ts` | ~20 | MCP server factory |
| `index.ts` | ~100+ | Bootstrap (stdio/HTTP), config loading |

### Tools (24 implementations)
Each tool file (~80-120 lines):
- Zod schema definition
- Handler function with API calls
- Error handling & pagination

**Example:** `orders-tool.ts`
- Actions: list, get, create, update, batch_update, delete, print, ship, call_later
- `batch_update` (max 50/call): per-order patches (`note`/`status`/`tags`/`note_print`) via `Promise.allSettled`. Counts as 1 upstream tool action — replaces fan-out N updates from LLM
- Uses: `client.getList()`, `client.post()`, `client.put()`, `client.delete()`

### Shared Utilities
| File | Responsibility |
|------|-----------------|
| `shared/schemas.ts` | Zod base types (PancakeResponse, PancakeListResponse) |
| `shared/error-handler.ts` | PancakeApiError class, formatToolError() |
| `shared/pagination-helpers.ts` | formatPaginatedResult() wrapper |

---

## Tool Phasing Strategy

### Phase 1: Core POS (4 tools)
**Business Value:** Basic order management  
**Tools:** manage_orders, manage_products, manage_customers, manage_inventory  
**Maturity:** Production-ready

### Phase 2: Supply Chain (5 tools)
**Business Value:** Inventory visibility & control  
**Tools:** manage_warehouses, manage_suppliers, manage_purchases, manage_transfers, manage_stocktaking  
**Maturity:** Production-ready

### Phase 3: Sales Extensions (4 tools)
**Business Value:** Advanced selling features  
**Tools:** manage_returns, manage_combos, manage_promotions, manage_vouchers  
**Maturity:** Production-ready

### Phase 4: CRM & Multi-Channel (5 tools)
**Business Value:** Sales pipeline + omnichannel  
**Tools:** manage_crm_contacts, manage_crm_deals, manage_crm_activities, manage_ecommerce, manage_livestream  
**Maturity:** Production-ready

### Phase 5: Operations (5 tools)
**Business Value:** Business intelligence & admin  
**Tools:** manage_employees, manage_webhooks, get_statistics, get_shop_info, lookup_address  
**Maturity:** Production-ready

---

## Recent Enhancements (2026-05-08)

### 1. Batch Update on Orders (2026-05-06)
**Motivation:** Production traces showed 446 single-order updates in 6h, burning rate-limit budget and adding MCP round-trips.

**Solution:** New `batch_update` action on `manage_orders` accepts up to 50 per-order patches (`note`, `status`, `tags`, `note_print`) and dispatches in parallel via `Promise.allSettled`, returning per-item ok/error. Counts as 1 upstream tool action.

**Files:** `tools/orders-tool.ts`, `tools/tool-registry.ts`

### 2. Compact Response Projection (2026-05-08)
**Feature:** New response-projection layer using json-mask with `verbosity` parameter.

**Coverage:** `orders`, `products`, `warehouses`, `address-lookup` (50–85% byte reduction via compact masks).

**Implementation:** 
- `src/shared/response-projection.ts` (json-mask wrapper)
- `src/shared/compact-masks.ts` (central registry of masks per tool)
- Tool handlers apply via `project(data, "compact")` or `project(data, "full")`

**Files:** `shared/response-projection.ts`, `shared/compact-masks.ts`, updates to 4 tools

**Backlog:** Remaining tools (combos, promotions, vouchers, CRM, ecommerce, livestream, employees, webhooks, statistics, shop-info) lack compact masks — flagged for future phases.

### 3. Replay Framework & Phase 6 Validation (2026-05-08)
**Framework:** `tests/replay/` with byte-reduction metrics validation against production traces.

**Components:** `replay-trace.ts`, `traces.json` fixture, `report.md` with phase 6 acceptance criteria.

**Files:** `tests/replay/replay-trace.ts`, `tests/replay/traces.json`, `tests/replay/report.md`

### 4. Array Serialization Fix (Phase 1, 2026-05-06)
**Issue:** Query parameters with arrays were JSON-stringified, triggering HTTP 500 on Pancake API list endpoints.

**Solution:** `buildQueryParams()` now returns `URLSearchParams` and serializes arrays as bracket-style `key[]=v1&key[]=v2`. Empty arrays are omitted. Nested arrays keep inner elements as JSON (e.g. `order_sources=[["-1","314"]]` preserves wire grouping).

**Files:** `api-client/request-builder.ts`

### 5. Sort Options Enum (Phase 2, 2026-05-06)
**Addition:** `src/shared/sort-options.ts` exports `ORDER_SORT_VALUES` (18 enum values) and `ORDER_SORT_DESCRIPTION`. 

**Impact:** `orders-tool.ts` `option_sort` parameter now uses `z.enum(ORDER_SORT_VALUES)` for strict validation. Tool descriptions expanded to document ANALYTICS PATTERNS (top-N queries with single API call using sort + page_size + fields[]).

**Files:** `shared/sort-options.ts`, `tools/orders-tool.ts`, `tools/tool-registry.ts`

### 6. Preserve Server-Side Aggregations (Phase 3, 2026-05-06)
**Feature:** Pancake API list endpoints return optional `aggs` (aggregation buckets) alongside paginated data.

**Solution:** 
- `PancakeListResponse.aggs?` field added (type `PancakeAggregations`)
- `parsePaginatedResponse()` forwards `aggs` when present
- `formatPaginatedResult()` forwards `aggs` (only if present; backward-compatible)

**Files:** `shared/schemas.ts`, `api-client/response-parser.ts`, `shared/pagination-helpers.ts`

### 7. Analytics Wrapper Tool (Phase 4, 2026-05-06)
**New Tool:** `analytics` (single tool with discriminated union `action`).

**Actions:**
- `top_orders` — Metric-driven ranking (total_price/total_quantity), limit, date range, status filter, custom fields
- `revenue_summary` — Revenue breakdown by payment method (cod, prepaid, shipping_fee, partner_fee) + status_breakdown aggregation

**Implementation:** Leverages aggs preservation + sort options; analytics queries execute in 1 API call (no pagination loops).

**Files:** `tools/analytics-tool.ts`, `tools/tool-registry.ts` (24 tools now)

### 8. Orders Delete: Display ID Resolver (2026-05-09)
**Feature:** `manage_orders action=delete` now defaults to interpreting `order_id` as `display_id` (small per-shop sequential number like 521 or 'A483'), with automatic resolver to internal Pancake id.

**Two-Stage Resolver:**
- **Stage 1 (Search-narrow):** `filter_status=[0] + search=<n> + page_size=200` — catches most cases where display_id is indexed
- **Stage 2 (Page-scan fallback, max 5×200 rows):** Full scan of recent status=0 orders when stage 1 returns empty

**Error Codes (new `PancakeApiError`):**
- `LIKELY_INTERNAL_ID` (400) — input >1M (looks like internal id; user should set `id_kind="id"`)
- `NOT_FOUND_DISPLAY_ID` (404) — no match in searched range
- `AMBIGUOUS_DISPLAY_ID` (409) — multiple orders match (user must disambiguate with internal id)
- `NOT_DRAFT` (409) — order status ≠0 (only draft orders deletable)
- `STATUS_UNKNOWN` (500) — pre-check GET succeeded but `status` field missing
- `ORDER_NOT_FOUND` (404) — pre-check GET returned 404 (order removed upstream)
- `ORDER_GONE` (404) — status=0 confirmed but DELETE returned 404 (raced with transition)

**Pre-Check:** Before DELETE, resolver verifies `status=0` via GET. Fails fast on non-draft orders.

**Field Resolution:** Response field named `system_id` (post-filter uses `system_id ?? display_id ?? id`).

**Files:** `tools/orders-tool.ts` (resolveOrderDisplayId function), test fixtures in `tests/fixtures/orders-delete/`

---

## Data Flow Patterns

### List Operations (Paginated)
```
Tool (user action="list", page_number=1, page_size=30)
  ↓
Handler parses params
  ↓
client.getList(path, params)  // Injects auth, rate limits, retries
  ↓
parsePaginatedResponse()  // Validates { error, status, data[], aggs?, ... }
  ↓
formatPaginatedResult(data, pagination, aggs?)  // Wraps for MCP
  ↓
Tool returns text JSON (includes aggs if server sent them)
```

### Single Item Operations (Get/Create/Update)
```
Tool (user action="get", id=123)
  ↓
Handler validates ID
  ↓
client.get/post/put/delete(path)
  ↓
parseResponse()  // Validates { error, status, data }
  ↓
Tool returns text JSON
```

### Error Handling
```
API Error (5xx) → Retry with backoff (up to 3 attempts)
API Error (4xx) → PancakeApiError thrown → formatToolError() → MCP error response
Network timeout (30s) → Abort → formatToolError() → MCP error response
```

---

## Rate Limiting Behavior

### Per-Request Flow
1. **Check token availability** (both minute & hour buckets)
2. **If insufficient tokens:** Sleep until refill brings tokens to 1+
3. **Deduct token** from both buckets
4. **Execute fetch** with 30s timeout
5. **On 5xx error:** Wait backoff, retry (deducts more tokens)

### Example Timeline (High Load)
```
Request 1: 0ms    - Token OK, execute
Request 2: 60ms   - Minute bucket refilled 1 token, execute
Request 3: 120ms  - Both buckets have 1 token, execute
Request 4: 180ms  - Minute bucket at 0, must wait 60ms for refill
Request 5: 240ms  - (if hour bucket also depleted, wait is MAX of both)
```

**Implication:** Sustained 1000 requests/minute requires ~60ms per request; AI assistants will see predictable delays at high throughput.

---

## Vietnam Address Handling

Pancake POS supports two coexisting address formats since the 2025-07-01
administrative reform:

- **OLD format (3-tier):** `province_id` → `district_id` → `commune_id`. Pre-reform IDs (e.g. `province_id="701"`).
- **NEW format (2-tier):** `new_province_id` → `new_commune_id`. Post-reform IDs (e.g. `new_province_id="84_VN129"`). District level was removed.

The shared `VietnamAddressSchema` (`src/shared/schemas.ts`) exposes both — all
fields optional, callsites `.extend({...})` for required contact fields. Order
GET responses include `shipping_address.{province_id, new_province_id, new_commune_id}`
when populated; callers should reuse those IDs rather than calling the
address-lookup tool.

**Handler validation** (`orders-tool.ts → assertAddressHasLocation`): on
`create`, at least one province anchor (`province_id` or `new_province_id`) is
required. On `update`, validation only fires when caller sends any location
field — pure contact updates (phone/name) bypass.

**Verify-after-update** (`orders-tool.ts → case "update"`): after PUT, if any
fragile field (`shipping_fee`, `partner_fee`, `is_free_shipping`) was sent, GET
the order and compare. Mismatches surface in `warnings: string[]` on the response,
each with a workaround hint. Pancake silently drops these fields on some shops.

**`address-lookup-tool` uses `/geo/*` endpoints** (verified 2026-04-28). The
`/address/*` paths used previously return 404 — the rename was discovered via
Pancake POS web UI capture. Routes:

- `geo/provinces` — list 63 OLD provinces; each has a `new_id` field mapping to NEW.
- `geo/districts?province_id={OLD}` — OLD-only (NEW has no district level).
- `geo/communes?province_id={OLD}` — OLD 3-tier across all districts in the province.
- `geo/communes?province_id={NEW}` — NEW 2-tier (server detects ID prefix).
- `geo/communes?district_id={OLD}` — OLD 3-tier filtered to one district.

Handler validates `communes` has at least one of `province_id`/`district_id`.
`/geo` is registered as a global prefix in `request-builder.ts` so it bypasses
shop scope.

### NEW format coverage (verified 2026-04-28)

| Entity | OLD fields in response | NEW (`new_*`) fields | Notes |
|---|---|---|---|
| `orders` | ✓ | ✓ | Dual-format applied in `VietnamAddressSchema` (see changelog entry 2026-04-28) |
| `customers` | ✓ via `shop_customer_addresses[]` (note: not `addresses[]`) | ✗ | Pancake has not migrated this endpoint to 2-tier yet |
| `warehouses` | ✓ flat fields | ✗ | Same — OLD only |
| `shop-info` | unknown | unknown | GET endpoint `/shops/{id}/shop` returns HTTP 404 — separate upstream issue |

Phase 3 of the address overhaul (apply `VietnamAddressSchema` to
customers/warehouses/shop-info) was **cancelled** rather than deferred (see
changelog 2026-04-28): exposing `new_*` fields on these tools would let LLMs
send IDs the backend silently drops. Re-evaluate when Pancake migrates the
remaining endpoints.

**`shop-info-tool` GET is also known-broken** — `/shops/{id}/shop` returns 404
on shop 123456789 with api_key. Update path (`shop/update`) untested. Not
wrapped with deprecation interceptor yet — investigation pending.

---

## Known Issues & Patterns

### Critical Issues (from code review)
1. **Path Traversal Risk:** `buildRequestUrl` doesn't encode path segments
   - `address-lookup-tool.ts` most exposed (uses `z.string()` for IDs)
   - Mitigation: UUID validation via `z.string().uuid()` in future
   
2. **getRaw() Missing Error Check:** `PancakeHttpClient.getRaw()` skips `response.ok` validation
   - Only `address-lookup-tool.ts` uses getRaw
   - Mitigation: Replace with `client.get()` or add error check

3. ~~**address-lookup-tool 404 upstream:**~~ Resolved 2026-04-28 — endpoint renamed `/address/*` → `/geo/*`. See *Vietnam Address Handling* above.

### Minor Inconsistencies
- `shop-info-tool.ts` uses `client.post("shop/update")` (unique pattern)
- `promotions-tool.ts` UpdateAction missing `applicable_product_ids` field
- Discount values have no bounds checking (allows negative/>100%)

### URL Routing Patterns
- **Global prefixes** (bypass shop scope): `["/partners", "/address", "/geo"]` (with/without leading slash)
- **Everything else:** `/shops/{shopId}/{path}`
- CRM, ecommerce, livestream, statistics all scoped to shop

---

## Configuration & Environment

### Required Environment Variables
```bash
PANCAKE_POS_BASE_URL=https://pos.pages.fm/api/v1  # Pancake API host (canonical per poscake-api-docs.md:14)
PANCAKE_POS_API_KEY=<your-api-key>               # Bearer token (injected as query param)
PANCAKE_POS_SHOP_ID=<shop-uuid>                  # Shop identifier (used in URL paths)
```

### Startup Modes
```bash
npm start                   # Default: stdio transport
npm start -- --stdio        # Explicit stdio mode
npm start -- --http         # Streamable HTTP (localhost:3000)
```

### TypeScript Compilation
```bash
npm run typecheck           # Runs tsc --noEmit (no output, errors only)
```

---

## Dependencies

### Direct Dependencies
- **@modelcontextprotocol/sdk**: v1.29.0 (MCP protocol implementation)
- **zod**: v4.3.6 (Runtime type validation)

### Platform
- **Bun**: Native runtime (fetch, crypto, etc. built-in)
- **TypeScript**: v5+ (type checking, no transpiler needed with Bun)

### Zero External HTTP Libraries
Uses native Bun `fetch()` for all HTTP requests; no axios/node-fetch required.

---

## Testing & Validation

### Compilation Verification
Run before commits:
```bash
npm run typecheck
```

Ensures no type errors; does NOT run code (safe for validation).

### Manual Integration Testing
Recommended checklist (not yet automated):
- [ ] Order list with pagination (tests rate limiter + pagination parser)
- [ ] Product create → variation create → update
- [ ] Warehouse transfer between two warehouses
- [ ] Webhook create + event subscription validation
- [ ] High throughput (100+ reqs/min) to verify rate limiting

### Known Test Gaps
- No unit tests (not in scope for Phase 1-5)
- No e2e tests against live Pancake API (credentials required)
- Rate limiter behavior not tested under load

---

## Deployment & Runtime

### Prerequisites
- Bun runtime installed
- Valid Pancake API credentials (.env file)
- Network access to Pancake API (pos.pages.fm)

### Production Deployment Options
1. **As CLI Tool** (stdio mode)
   ```bash
   bun run src/index.ts --stdio
   ```
   Suitable for Claude Desktop integration, scripting, one-off commands.

2. **As HTTP Server** (Streamable HTTP mode)
   ```bash
   bun run src/index.ts --http
   ```
   Suitable for multi-user/multi-tool orchestration, API gateways.

### Performance Characteristics
- **Startup:** ~500ms (Bun startup + MCP bootstrap)
- **Per-request latency:** 50-100ms (HTTP + rate limiter + parsing)
- **Memory footprint:** ~50MB (Bun + SDK + rate limiter state)
- **Concurrency limit:** Enforced by rate limiter (1000 req/min soft limit)

---

## Future Enhancements

### Recommended Short-Term
1. Add unit tests for rate limiter behavior
2. Fix path traversal vulnerability (encode segments)
3. Add getRaw() error check in address-lookup-tool.ts
4. Validate discount values (0-100% range)

### Recommended Medium-Term
1. Implement caching layer for frequently accessed resources (products, categories)
2. Add webhook event type validation
3. Support batch operations for bulk imports
4. Add integration tests against Pancake sandbox API

### Recommended Long-Term
1. Add GraphQL layer for complex multi-tool queries
2. Implement event streaming for real-time updates
3. Add AI-driven tool composition (agent reasoning)
4. Multi-shop support (currently single-shop per instance)

---

## References

- **API Documentation:** `/docs/poscake-api-docs.md` (Pancake API reference)
- **OpenAPI Spec:** `/docs/pancake-openapi-spec.json` (machine-readable API schema)

---

**Last Updated:** 2026-05-12
