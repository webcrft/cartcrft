# CartCrft Documentation

Developer reference for the CartCrft headless commerce backend.

---

## Reading order

Start here if you are new to the project. Work top-to-bottom if you are setting
up a deployment; jump to a specific doc if you have a targeted question.

| Doc | What it covers |
|-----|----------------|
| [quickstart.md](./quickstart.md) | Local dev: prereqs, install, migrate, seed, first API calls |
| [quickstart-mcp.md](./quickstart-mcp.md) | Agent flow: seed → MCP client config → scripted 9-step purchase walkthrough |
| [api-overview.md](./api-overview.md) | Auth (JWT vs cc_ keys), error envelope, idempotency, pagination, money encoding |
| [commerce.md](./commerce.md) | Commerce engine overview — catalog, inventory, orders, payments, B2B, subscriptions, bookings |
| [byo-keys.md](./byo-keys.md) | Payment providers (Stripe / Paystack / Razorpay / Xendit), LLM key for semantic search, secret encryption |
| [checkout-links.md](./checkout-links.md) | Shareable hosted checkout links, public token flow, iframe embed |
| [agent-native.md](./agent-native.md) | MCP server, semantic search, ACP adapter, agent registry, mandates, spend limits |
| [acp.md](./acp.md) | ACP adapter spec pin, endpoint table, field mapping, divergences |
| [ucp.md](./ucp.md) | UCP adapter — catalog entities + checkout (Google surfaces / NRF baseline) |
| [self-host.md](./self-host.md) | Docker Compose, environment variables, production checklist |
| [cloud-vs-selfhost.md](./cloud-vs-selfhost.md) | MIT core vs cloud/ license, what the cloud layer adds, self-host completeness |
| [security.md](./security.md) | Tenant isolation, RLS, IDOR sweep, auth secrets |
| [contributing.md](./contributing.md) | Monorepo layout, pnpm commands, migration rules, commit style |
| [testing.md](./testing.md) | Test harness design, writing a suite, simulated time for billing |
| [parity-endpoints.md](./parity-endpoints.md) | Full endpoint table with auth tiers (T2.1–T2.10) |
| [openapi.json](./openapi.json) | OpenAPI 3.1 spec (generated — do not edit by hand) |

---

## Quick links

- **Running locally** — [quickstart.md](./quickstart.md)
- **Buying with an AI agent** — [quickstart-mcp.md](./quickstart-mcp.md)
- **API auth + error codes** — [api-overview.md](./api-overview.md)
- **Configuring payment providers** — [byo-keys.md](./byo-keys.md)
- **Self-hosting** — [cloud-vs-selfhost.md](./cloud-vs-selfhost.md)

---

## External references

- Root README: [../README.md](../README.md)
- Monorepo roadmap: [../roadmap.md](../roadmap.md)
- MCP tools reference: [../mcp/README.md](../mcp/README.md)
