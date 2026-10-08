# Project Changelog

## [Unreleased]

### Auth error clarity + HTTP client attempt budget (2026-10-08)

**Motivation:** Issue #2 — users saw `403` on both `pos.pages.fm` and `pos.pancake.vn` with an apparently correct key. Live probing showed Pancake returns `403 {"message":"api_key is invalid","error_code":105}` only when the key itself is rejected (a wrong shop ID yields `404`), and a trailing space/newline from copy-paste is enough to trigger it.

**Changes:**
- `src/config.ts`: `PANCAKE_POS_API_KEY` and `PANCAKE_POS_SHOP_ID` are trimmed.
- `src/api-client/response-parser.ts`: `403` + `error_code 105` maps to `INVALID_API_KEY` with an actionable message; other `403`s stay `FORBIDDEN`. Duplicate non-OK handling merged into `toApiError`.
- `src/api-client/pancake-http-client.ts`: `HttpClientOptions.maxRetries` renamed to `maxAttempts` (it always counted total attempts). Values `< 1` are clamped to 1 — previously `maxRetries: 0` skipped the request entirely and threw `NETWORK_ERROR ... undefined`. Defaults unchanged (Bun 3, Workers 2).

**API Behavior:** `HttpClientOptions.maxRetries` → `maxAttempts` (internal option; `src/worker.ts` updated).

### Orders delete: display_id resolver + status pre-check (2026-05-09)

**Scope:** Display ID resolver for `manage_orders action=delete` to enable human-readable order deletion + structured error codes + pre-check validation.

**Motivation:** Production orders have small per-shop sequential numbers (display_id: 521, 'A483') which are easier for humans and LLMs to work with than large internal Pancake ids. Previously, users had to manually resolve display_id → internal id before calling delete; added friction and failure surface.

**Changes:**
- `src/tools/orders-tool.ts`: new `resolveOrderDisplayId(displayId)` async function implementing two-stage resolver:
  - Stage 1: `getList("orders", {search: displayId, filter_status: [0], page_size: 200})` — catches most hits where display_id is indexed
  - Stage 2 (fallback): page-scan up to 5×200 rows when stage 1 returns empty (handles edge cases where search doesn't reach system_id)
  - Pre-check: GET `orders/{id}` to verify `status === 0` before DELETE (fail fast on non-draft, inform user)
  - Field resolution: post-filter uses `system_id ?? display_id ?? id` for cross-format compatibility
- `DeleteAction` schema: new `id_kind` enum ("display_id" | "id"); defaults to "display_id"; `order_id` widened to `union([number, string])` for alphanumeric display_ids
- Structured error codes (all returned as `PancakeApiError`):
  - `LIKELY_INTERNAL_ID` (400) — input >1M (looks like internal id; user should retry with `id_kind="id"`)
  - `NOT_FOUND_DISPLAY_ID` (404) — no match in searched range; suggests checking order exists + is draft
  - `AMBIGUOUS_DISPLAY_ID` (409) — multiple orders match; error message includes internal ids for disambiguation
  - `NOT_DRAFT` (409) — order status ≠ 0 (only status=0 deletable); suggests `action="update"` to transition
  - `STATUS_UNKNOWN` (500) — pre-check GET succeeded but status missing (upstream inconsistency)
  - `ORDER_NOT_FOUND` (404) — pre-check GET returned 404 (order removed upstream)
  - `ORDER_GONE` (404) — status=0 confirmed but DELETE returned 404 (raced with transition or deletion)
- Test fixtures: 5 HTTP traces under `tests/fixtures/orders-delete/` covering success, not-found, ambiguous, not-draft, order-gone scenarios
- Documentation: `docs/system-architecture.md` (new error codes table), `docs/codebase-summary.md` (resolver flow), `docs/code-standards.md` (error handling patterns), `README.md` (feature note)

**Backlog:** Extend `id_kind` resolver to `update`, `print`, `ship`, `batch_update` actions (currently delete-only for MVP scope; can reuse `resolveOrderDisplayId()` function).

**Plan Reference:** `plans/260508-2233-orders-delete-display-id-resolver/`

**API Behavior:** Breaking change (delete action now interprets order_id as display_id by default). Users upgrading must set `id_kind="id"` if they have internal ids, or update to pass display_ids. Semantic error codes guide troubleshooting.

**Test Status:** All vitest pass; manual fixtures verified against production traces.

---

### Response projection & replay validation (2026-05-08)

**Scope:** Compact response projection layer (json-mask) + Phase 6 replay-trace validation framework + documentation updates.

**Changes:**
- `src/shared/response-projection.ts` (new): json-mask wrapper with `verbosity` parameter ("compact" | "full")
- `src/shared/compact-masks.ts` (new): Central registry of compact masks for orders, products, warehouses, address-lookup (50–85% byte reduction)
- `tests/replay/` (new): Phase 6 validation framework with `replay-trace.ts`, `traces.json` fixture, `report.md` acceptance criteria
- `pre-commit` hooks: PII guard for tests/fixtures; diacritic check skipped for geo-*.json
- `docs/code-standards.md`: Added dual-schema gotcha section (critical: tool file schema + tool-registry inline schema must match), response-projection guidance for new tools, batch_update exception note, z.coerce.number() guidance
- `docs/codebase-summary.md`: Updated Recent Enhancements section
- `docs/project-roadmap.md`: Added Phase 6 milestone

**API Behavior:** Backward-compatible. New compact mode is default; callers can request full via `verbosity=full` or `fields[]` parameter.

**Impact:** Orders list responses ~50% smaller. Response projection framework established for future tool expansion (combos, promotions, vouchers, CRM, ecommerce, livestream, employees, webhooks, statistics, shop-info backlog).

---

### Bulk order updates: `batch_update` action (2026-05-06)

**Motivation:** Production trace from a high-volume Zalo sales bot showed 446 `manage_orders` update calls in 6h with peak 117/h, all single-order patches (`{action:"update", note:"Đã ck", order_id:N}`) fan-out 8-10 in one millisecond. Burned upstream rate budget (goclaw enforces 150 tool calls/h per session) and added needless MCP round-trips while every payload had identical shape.

**Change:** New `batch_update` action on `manage_orders` accepts `updates: [{order_id, note?, status?, tags?, note_print?}]` (max 50 per call) and dispatches PUT `orders/{id}` in parallel via `Promise.allSettled`. Returns per-item ok/error so partial failures don't abort the batch.

- `src/tools/orders-tool.ts`: new `BatchUpdateAction` schema + `case "batch_update"` handler
- `src/tools/tool-registry.ts`: action enum + `updates` param + tool description with usage example
- `tests/tools/orders-tool-schema.test.ts`: 7 new cases (4 schema, 3 handler covering success / partial-failure / empty-update rejection)

**Scope decisions (YAGNI):**
- Excluded `items[]` (would require per-order `GET orders/{id}` status pre-check, defeating batch perf)
- Excluded `shipping_address` (rarely batched in practice)
- Excluded fragile financial fields (`shipping_fee`, `total_discount`, `surcharge`) — verify-after-update is skipped in batch mode; response carries a note pointing callers at `get` for audit
- Token bucket already in `PancakeHttpClient` (1000/min, 10000/h) backstops the parallel fan-out at the Pancake API edge

**Result:** 104/104 tests pass, typecheck clean. Same workload should drop ~117 update calls/h to ~3-5 batch calls/h.

---

### Analytics gap fix: array serialization + sort enum + aggs preservation + analytics tool (2026-05-06)

**Scope:** 4 phases addressing array query param serialization bug, sort options enum, server-side aggregation forwarding, and new analytics wrapper tool.

**Phase 1 — Array Serialization Bug**
- **Issue:** Query arrays were JSON-stringified (`key=["a","b"]`), triggering HTTP 500 on Pancake list endpoints (expects bracket-style `key[]=a&key[]=b`).
- **Fix:** `buildQueryParams()` now returns `URLSearchParams`, iterates arrays with `sp.append(key[], value)`. Empty arrays omitted; nested arrays preserve inner JSON.
- `api-client/request-builder.ts`: new `buildQueryParams()` signature + bracket-style serialization
- `tests/api-client/request-builder.test.ts` (new): 12 cases covering arrays, empty arrays, nested arrays, nulls

**Phase 2 — Sort Options Enum + Tool Descriptions**
- `src/shared/sort-options.ts` (new): `ORDER_SORT_VALUES` (18 enum values), `ORDER_SORT_DESCRIPTION` with analytics pattern examples
- `orders-tool.ts`: `option_sort` switched `z.string()` → `z.enum(ORDER_SORT_VALUES)`; expanded fields description
- `tool-registry.ts`: synced inline schema + added "ANALYTICS PATTERNS" and "RESPONSE INCLUDES SERVER-SIDE AGGREGATIONS" blocks to `manage_orders` description (dual-schema gotcha)
- `tests/tools/orders-tool-schema.test.ts` (new): 4 cases for enum validation

**Phase 3 — Preserve Server-Side Aggregations**
- `schemas.ts`: added `PancakeAggregationValue` (union of numeric value or bucket array), `PancakeAggregations` map, `PancakeListResponse.aggs?` optional field
- `response-parser.ts`: `parsePaginatedResponse()` forwards `aggs` from body when present
- `pagination-helpers.ts`: `formatPaginatedResult()` forwards `aggs` (additive, backward-compatible; only when present)
- `tests/shared/pagination-helpers.test.ts` + `tests/api-client/response-parser.test.ts` (new): 6 cases

**Phase 4 — Analytics Wrapper Tool**
- `tools/analytics-tool.ts` (new): single `analytics` tool with discriminated union
  - `top_orders` action: metric (total_price|total_quantity), limit (1-100), date range, status filter, fields override. Uses sort + page_size for single-call top-N
  - `revenue_summary` action: returns revenue_cod, prepaid, shipping_fee, partner_fee, total_orders, status_breakdown, currency="VND"
- `tool-registry.ts`: registers `analytics` tool (24 total now)
- `tests/tools/analytics-tool.test.ts` (new): 12 cases
- `tests/e2e-mcp.test.ts`: bumped tool count 23→24; asserts `analytics` registered
- `README.md` + `codebase-summary.md` (previous): already updated tool count references

**Test Status:** 95/95 vitest pass, `tsc --noEmit` clean.

**API Behavior:** Fully backward-compatible. New features only.

### orders update: items support + total_discount/surcharge silent-drop guards (2026-05-06)

**Scope:** Fix 3 reports against `manage_orders` (update silent-drops items; total_discount no-op; delete 404).

**Root causes:**
- `items` on `update`: dual-schema mismatch — `tool-registry.ts` exposed `items` to the LLM, but the inner `UpdateAction` (Zod discriminated union) did not declare it, so `.parse()` stripped it before reaching `client.put()`. Pancake API supports replacing items via `PUT /orders/<id>` when order `status === 0` (per `docs/poscake-api-docs.md:264, 284`).
- `total_discount` / `surcharge`: same class as `shipping_fee`/`partner_fee`/`is_free_shipping`/`customer_pay_fee` — silently dropped or recomputed under `api_key` auth. Not previously surfaced.
- DELETE 404: not an MCP bug. Endpoint and URL match spec exactly. 404 reflects business state (order absent / wrong shop / `status > 0`). No code change.

**Changes:**
- `UpdateAction` now accepts `items` (optional). Shape extracted into shared `OrderItemSchema` (DRY with `CreateAction`).
- Pre-GET `status` check on update when `items` present; throws fast with order id + actual status if `status >= 1` (Pancake constraint).
- `FRAGILE_FIELDS` extended with `total_discount`, `surcharge` → verify-after-update warnings now surface for these.
- `tool-registry.ts` inline schema synced (item shape parity with inner schema, action description updated).
- 4 new tests in `tests/orders-tool.test.ts` covering: items schema acceptance, status===0 happy path, status>=1 rejection, total_discount silent-drop warning.

**API Behavior:** Backward-compatible. New capabilities only.

**Verification:** typecheck clean (`tsc --noEmit`); full vitest suite 61/61 pass.

### Public-release preparation (2026-04-29)

**Scope:** Git history cleanup and repository preparation for public release.

**Changes:**
- Shop ID redaction: real shop ID replaced with a placeholder across tests, docs, and tool comments
- Removed internal artifacts: `.claude/`, `plans/`, `docs/journals/`, `.gitkeep` scrubbed from git history via `git filter-repo`
- Personal filesystem path redaction: absolute developer paths rewritten to relative form in history
- Added MIT LICENSE at repo root for open-source distribution
- Updated `.gitignore` to ignore `.claude/`, `plans/`, `docs/journals/`, `.gitkeep` going forward
- Force-pushed cleaned history to remote (private repo, ready to flip to public)
- Tracked file count reduced from 105 → 68 (artifacts, internal docs removed)

**API Behavior:** No changes — all tools, resources, and transport modes remain unchanged.

**Documentation:** Verified all references to shop ID, filesystem paths, and plan locations are accurate for public state.

---

## 2026-04-29 — address-lookup migrated `/address/*` → `/geo/*`

Discovered via Pancake POS web UI network capture. Endpoint was renamed (not removed) and behavior subtly improved:

- `GET /api/v1/geo/provinces` — 63 OLD provinces, each item carries a `new_id` field mapping to NEW format. No separate NEW provinces endpoint exists.
- `GET /api/v1/geo/districts?province_id={OLD}` — OLD only. NEW format has no district level.
- `GET /api/v1/geo/communes?district_id={OLD}` — OLD 3-tier in one district.
- `GET /api/v1/geo/communes?province_id={OLD}` — OLD 3-tier across the province.
- `GET /api/v1/geo/communes?province_id={NEW}` — NEW 2-tier; server detects the `84_VN...` prefix and returns 2-tier shape (`district_id: null`).

Verified on both `pos.pages.fm` and `pos.pancake.vn` with api_key (no JWT needed).

### Changed
- `src/tools/address-lookup-tool.ts`: schema now allows `communes` with `province_id` (OLD or NEW) and/or `district_id` (OLD only); handler asserts at least one is present. Switched from `client.getRaw` to `client.get` to pick up `success: false` validation. Removed the 404 deprecation wrapper.
- `src/api-client/request-builder.ts`: added `/geo` (with and without leading slash) to `globalPrefixes` so the path bypasses shop scope.
- `tests/address-lookup-tool.test.ts`: replaced 3 deprecation tests with 14 cases covering schema, dispatch, validation, and request-builder URL shape.
- `docs/codebase-summary.md`: replaced "known-broken" note with route reference; updated global-prefix list and Critical Issues #3.

---

## 2026-04-28 — Orders update fields & VN address schema overhaul

Plan: `plans/260428-1730-orders-address-schema-overhaul/`

### Added
- `VietnamAddressSchema` shared (`src/shared/schemas.ts`) — supports both OLD 3-tier (`province_id`+`district_id`+`commune_id`) and NEW 2-tier (`new_province_id`+`new_commune_id`) Vietnamese address formats post-2025-07-01 administrative reform.
- `orders update` financial fields: `shipping_fee`, `partner_fee`, `is_free_shipping`, `total_discount`, `surcharge`, `note_print`, `received_at_shop`, `custom_id`, `bill_email`.
- Verify-after-update for orders: when any fragile field (`shipping_fee`, `partner_fee`, `is_free_shipping`) is sent in an update, the handler GETs the order to detect silent-drops and surfaces `warnings: string[]` with per-field workaround hints.
- Handler-layer `assertAddressHasLocation` enforcing province anchor on order create; on update, only when caller sends location fields.

### Changed
- `orders-tool.ts` `CreateAction.shipping_address` and `UpdateAction.shipping_address` now use `VietnamAddressSchema`. `district_id` / `commune_id` are no longer required on create.
- `address-lookup-tool.ts` wraps handler with 404 interceptor, throws structured deprecation message with workaround. Tool surface kept for forward-compat.
- `vitest.config.ts` pins `compatibilityDate: "2026-04-01"` for both plugin and pool to keep miniflare runtime within supported range.

### Excluded (verified silent-drop / out of scope)
- `customer_pay_fee` on `orders update` — Pancake api_key auth silently ignores this field (verified 2026-04-28 on shop 123456789). Schema rejects it.
- Phase 3 (apply VietnamAddressSchema to customers/warehouses/shop-info) **cancelled** after shape verification on 2026-04-28: customers uses `shop_customer_addresses[]` (not `addresses[]`); none of the three endpoints expose `new_*` fields in responses. Pancake has not migrated those endpoints to the 2-tier reform. Bonus: `shop-info-tool` GET endpoint `/shops/{id}/shop` returns HTTP 404 — separate broken endpoint, not yet wrapped.

### Deprecated
- ~~`address-lookup-tool`~~ — superseded by `/geo/*` migration (see entry below dated 2026-04-29).

### Tests
- `tests/shared-schemas.test.ts` — 7 cases for `VietnamAddressSchema`.
- `tests/orders-tool.test.ts` — 17 cases (schema + handler create/update validation + verify-after-update).
- `tests/address-lookup-tool.test.ts` — 3 cases (404 wrapper, non-404 passthrough, success forward-compat).
- Total suite: 46 tests passing.

### References
- Brainstorm: `plans/reports/brainstorm-260428-orders-address-schema-overhaul.md`
- Preflight findings: `plans/260428-1730-orders-address-schema-overhaul/preflight-findings.md`
