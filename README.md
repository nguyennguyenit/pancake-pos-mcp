[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/nguyennguyenit-pancake-pos-mcp-badge.png)](https://mseep.ai/app/nguyennguyenit-pancake-pos-mcp)

# Pancake POS MCP

Model Context Protocol (MCP) server wrapping the Pancake POS REST API, enabling AI assistants like Claude to manage Vietnamese e-commerce POS operations with 24 specialized tools and 7 reference resources.

## Overview

Pancake POS MCP exposes the Pancake POS API (https://pos.pages.fm/api/v1) as Model Context Protocol tools, allowing Claude and other AI assistants to automate POS management across:

- **Core POS:** Orders, Products, Customers, Inventory
- **Supply Chain:** Warehouses, Suppliers, Purchases, Transfers, Stocktaking
- **Sales:** Returns, Exchanges, Combos, Promotions, Vouchers
- **CRM:** Contacts, Deals, Activities
- **Multi-Channel:** eCommerce (Shopee/Lazada/TikTok), Livestream Commerce
- **Operations:** Employees, Webhooks, Analytics, Shop Info, Address Lookup

## Prerequisites

- **Bun** (runtime) — install from https://bun.sh (`curl -fsSL https://bun.sh/install | bash`)
- **Pancake POS API Key** + **Shop ID** — see [Getting Pancake POS credentials](#getting-pancake-pos-credentials) below. Note: this is the **Pancake POS** (e-commerce / inventory) API, not the Pancake user/social-inbox API — different products, different keys.
- **Node.js 18+** (optional, for development tooling)

## Quick Start

Get from zero to a working MCP server in ~5 minutes:

```bash
# 1. Clone the repo
git clone https://github.com/nguyennguyenit/pancake-pos-mcp.git
cd pancake-pos-mcp

# 2. Install dependencies
bun install

# 3. Configure credentials
cp .env.example .env
# Open .env and fill in PANCAKE_POS_API_KEY + PANCAKE_POS_SHOP_ID
# (See "Getting Pancake POS credentials" section below)

# 4. Verify it runs
bun run src/index.ts
# Expected output:
#   [pancake-pos-mcp] Server started on stdio transport
# Press Ctrl+C to stop.

# 5. Connect Claude Desktop — see "Stdio Transport" section below
```

If step 4 prints an error, double-check your `.env` values and that you ran `bun install`. Common issues are listed in [Troubleshooting](#troubleshooting).

## Getting Pancake POS credentials

> ⚠️ **Pancake POS** ≠ **Pancake (social inbox)**. This MCP only works with the **Pancake POS** product at https://pos.pages.fm — the e-commerce / inventory / order-management system. The Pancake user/inbox API at `pages.fm` is a different product with a different API key and is not supported here.

You need two values from your Pancake POS account:

1. **`PANCAKE_POS_SHOP_ID`** — the numeric ID of your shop
   - Log in to https://pos.pages.fm and check the URL or shop settings to find the numeric shop ID
2. **`PANCAKE_POS_API_KEY`** — your Pancake POS API token
   - Pancake POS Dashboard → **Cài đặt** (Settings) → **API** → **Generate API key**
   - Copy the key immediately — it is only shown once

> Keep both values secret. Never commit them to git. The `.gitignore` already excludes `.env` and `.dev.vars`.

## Configuration

Required (set in Quick Start):

| Variable | Purpose |
|---|---|
| `PANCAKE_POS_API_KEY` | Pancake POS API token |
| `PANCAKE_POS_SHOP_ID` | Numeric shop ID |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `PANCAKE_POS_BASE_URL` | `https://pos.pages.fm/api/v1` | Override API endpoint |
| `PORT` | `3000` | HTTP transport port |
| `MCP_AUTH_TOKEN` | _(none)_ | Bearer token for HTTP/Workers auth |

## Usage

### Stdio Transport (Claude Desktop)

Default mode. Add to Claude Desktop config `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pancake-pos": {
      "command": "bun",
      "args": ["run", "/path/to/pancake-pos-mcp/src/index.ts"]
    }
  }
}
```

### HTTP Transport (Remote Access)

Enable Streamable HTTP transport:

```bash
bun run src/index.ts --http
```

Server starts at `http://localhost:3000/mcp`. Health check: `http://localhost:3000/health`

With authentication (recommended for production):

```bash
# .env
PORT=3000
MCP_AUTH_TOKEN=your_secret_token

# Client usage
curl -H "Authorization: Bearer your_secret_token" http://localhost:3000/mcp
```

### Cloudflare Workers (Serverless Edge)

Deploy globally on Cloudflare Workers for low-latency access from anywhere:

```bash
# Local development (uses .dev.vars for secrets)
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your credentials
bun run dev:workers
# Runs at http://localhost:8787

# Deploy to Cloudflare
wrangler login
bun run deploy

# Set production secrets
wrangler secret put PANCAKE_POS_API_KEY
wrangler secret put PANCAKE_POS_SHOP_ID
wrangler secret put MCP_AUTH_TOKEN
```

Workers URL: `https://pancake-pos-mcp.<your-subdomain>.workers.dev/mcp`

**Connect Claude Desktop via mcp-remote:**

```json
{
  "mcpServers": {
    "pancake-pos": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://pancake-pos-mcp.<your-subdomain>.workers.dev/mcp",
        "--header", "Authorization: Bearer <your-token>"
      ]
    }
  }
}
```

**Workers characteristics:** 8s timeout per upstream call, 2 retries, rate limiter disabled (stateless per-request model). Free tier: 100k requests/day. See [deployment guide](./docs/deployment-guide.md) for full details.

## Available Tools

24 tools, grouped by business domain.

### Core POS

| Tool | Description |
|------|-------------|
| `manage_orders` | Create, read, update, delete, print, ship, manage status; `batch_update` patches up to 50 orders/call |
| `manage_products` | Product catalog with variations and pricing |
| `manage_customers` | Customer CRUD, reward points, transaction history |
| `manage_inventory` | Inventory reports filtered by warehouse, category, supplier |

### Supply Chain & Warehousing

| Tool | Description |
|------|-------------|
| `manage_warehouses` | Warehouse CRUD and configuration |
| `manage_suppliers` | Supplier contact and profile management |
| `manage_purchases` | Purchase orders and inbound inventory |
| `manage_transfers` | Warehouse-to-warehouse transfer management |
| `manage_stocktaking` | Physical inventory count records |

### Sales Extensions

| Tool | Description |
|------|-------------|
| `manage_returns` | Order returns and exchange processing |
| `manage_combos` | Product bundle deals and time-limited offers |
| `manage_promotions` | Discount campaigns (percent/amount-based) |
| `manage_vouchers` | Voucher code generation and usage tracking |

### CRM & Multi-Channel

| Tool | Description |
|------|-------------|
| `manage_crm_contacts` | CRM contact CRUD and relationship management |
| `manage_crm_deals` | Sales pipeline opportunities and stages |
| `manage_crm_activities` | Calls, meetings, tasks, notes tied to contacts/deals |
| `manage_ecommerce` | Multi-channel sync (Shopee, Lazada, TikTok) |
| `manage_livestream` | Live selling session management and scheduling |

### Operations & Business Intelligence

| Tool | Description |
|------|-------------|
| `manage_employees` | Staff management and warehouse assignments |
| `manage_webhooks` | Event subscription and webhook configuration |
| `get_statistics` | Inventory, sales, orders with grouping |
| `analytics` | Top orders + revenue summary via server-side ES aggregations (no pagination loops) |
| `get_shop_info` | Shop profile information and settings |
| `lookup_address` | Vietnamese address hierarchy via `/geo/*` (OLD 3-tier + NEW 2-tier post-2025-07-01) |

## Available Resources

Static reference resources (no authentication required):

| Resource | Contents |
|----------|----------|
| `order-statuses` | 16 order status codes with Vietnamese/English names |
| `order-sources` | Sales channel codes (Facebook, Shopee, Lazada, etc.) |
| `sort-options` | 22 sort options for order listing |
| `webhook-events` | Webhook event types (order.created, order.updated, etc.) |
| `error-codes` | HTTP error code reference |
| `rate-limits` | API rate limits (1000/min, 10000/hour) |
| `shipping-partners` | Live shipping partner data (cached from API) |

## Architecture

- **API Client:** Token-bucket rate limiting (1000/min, 10000/hour), exponential backoff retries (3 attempts; Workers: 2)
- **Tools:** 24 MCP tools organized by business domain
- **Schema Validation:** Zod with discriminated unions, `z.coerce.number()` for stringified numbers from LLM clients
- **Transport:** Stdio (default) + Streamable HTTP + Cloudflare Workers with optional Bearer token auth
- **Error Handling:** Structured error responses with code and message
- **Compact responses:** `verbosity: "compact"` (default) trims payloads 60–85% on orders, products, warehouses, lookup_address; `"full"` for debugging
- **Bulk ops:** `manage_orders` `batch_update` action patches up to 50 orders per call
- **Display ID resolver:** `manage_orders action=delete` defaults to interpreting `order_id` as `display_id` (small per-shop number like 521 or 'A483') via a two-stage search+scan resolver; set `id_kind="id"` to pass internal Pancake id directly. Returns structured error codes: `LIKELY_INTERNAL_ID`, `NOT_FOUND_DISPLAY_ID`, `AMBIGUOUS_DISPLAY_ID`, `NOT_DRAFT`, `STATUS_UNKNOWN`, `ORDER_NOT_FOUND`, `ORDER_GONE`.
- **Replay validation:** `tests/replay/` re-runs production traces against local handlers to gate response-size regressions

## Development

### Type Checking

```bash
bun run typecheck
```

### Run Tests

```bash
bun run test       # vitest (includes Workers tests)
```

### Project Structure

```
src/
├── api-client/              # HTTP layer with rate limiting
│   ├── pancake-http-client.ts
│   ├── request-builder.ts
│   └── response-parser.ts
├── tools/                   # 24 MCP tools (24 files)
├── resources/               # MCP reference resources
├── shared/                  # Schemas, errors, pagination
├── config.ts                # Environment configuration
├── server.ts                # MCP server factory
├── worker.ts                # Cloudflare Workers entry point
└── index.ts                 # Entry point (stdio + HTTP)
```

See [docs/code-standards.md](./docs/code-standards.md) for full development guidelines.

## Documentation

- **[codebase-summary.md](./docs/codebase-summary.md)** — Architecture and implementation overview
- **[system-architecture.md](./docs/system-architecture.md)** — Detailed system design and data flows
- **[code-standards.md](./docs/code-standards.md)** — TypeScript and tool implementation standards
- **[project-overview-pdr.md](./docs/project-overview-pdr.md)** — Project requirements and features
- **[deployment-guide.md](./docs/deployment-guide.md)** — Setup and deployment instructions
- **[project-roadmap.md](./docs/project-roadmap.md)** — Implementation progress and milestones
- **[poscake-api-docs.md](./docs/poscake-api-docs.md)** — Complete Pancake POS API reference

## Troubleshooting

A few non-obvious gotchas:

- **`429 Too Many Requests`** — hit Pancake rate limit (1000/min, 10000/hour). The built-in token bucket auto-throttles; reduce parallelism on the caller side.
- **Tests fail with `Cannot find package 'cloudflare:test'`** — use `bun run test` (vitest), not native `bun test`. Workers tests need the vitest pool worker plugin.
- **Claude Desktop doesn't see the tools** — the `command`/`args` path in `claude_desktop_config.json` must be absolute. Restart Claude Desktop after editing the config.

For other errors, check the error message and verify `.env` credentials.

## License

MIT License — See [LICENSE](./LICENSE) file for full text.
