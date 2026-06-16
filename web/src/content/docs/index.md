---
title: CartCrft Docs
description: Headless commerce for agent-native storefronts — quickstarts, API reference, self-hosting, and protocol adapters.
template: splash
hero:
  tagline: Headless commerce for agent-native storefronts. MIT core, BYO keys, MCP + ACP + UCP out of the box.
  actions:
    - text: Quickstart
      link: /quickstart/
      icon: right-arrow
      variant: primary
    - text: MCP — Buy in 10 minutes
      link: /quickstart-mcp/
      icon: external
      variant: secondary
---

## What is CartCrft?

CartCrft is a headless commerce backend built from the ground up for AI-agent storefronts. Every store gets a full **Model Context Protocol (MCP) server** — any MCP-capable agent (Claude, a custom LLM, your own orchestrator) can search products, build carts, and complete purchases without writing any glue code.

The MIT-licensed core runs on Postgres 16 + pgvector. Payment providers, LLM keys, and email are all bring-your-own — no platform take rate.

---

## Where to start

| If you want to… | Go here |
|---|---|
| Run CartCrft locally and hit the API | [Quickstart](/quickstart/) |
| Let an AI agent buy something end-to-end | [MCP — Buy in 10 minutes](/quickstart-mcp/) |
| Bring your own Stripe / Paystack / LLM key | [BYO Keys](/byo-keys/) |
| Deploy to production | [Self-hosting](/self-host/) |
| Understand MIT vs cloud licensing | [Cloud vs Self-host](/cloud-vs-selfhost/) |
| Read the full API surface | [API Overview](/api-overview/) · [Endpoint Reference](/parity-endpoints/) |
| Integrate with ACP or UCP | [Agent-native](/agent-native/) · [ACP Adapter](/acp/) · [UCP Adapter](/ucp/) |
| Understand the security model | [Security & RLS](/security/) |
| Contribute or run tests | [Contributing](/contributing/) · [Testing](/testing/) |

---

## Key concepts

**MCP server** — every store exposes `/mcp/:storeId` over HTTP/SSE (and stdio for local dev). Tools include `search_products`, `create_cart`, `add_to_cart`, `start_checkout`, `complete_checkout`, and more. See [Agent-native](/agent-native/).

**BYO keys** — CartCrft has a zero take rate. You configure your own Stripe, Paystack, Razorpay, or Xendit credentials per store. Your own OpenAI / embedding key unlocks semantic (vector) search. See [BYO Keys](/byo-keys/).

**ACP + UCP adapters** — first-class support for the Agentic Commerce Protocol (2026-04 baseline) and Universal Commerce Protocol (Google surfaces / NRF 2026-01). See [ACP Adapter](/acp/) and [UCP Adapter](/ucp/).

**Mandates** — verifiable consent records (intent → cart → payment) signed with ed25519 keypairs, enforcing spend limits per agent. See [Agent-native](/agent-native/#mandates--intent--cart--payment-chain).

**MIT core** — everything except `cloud/` is MIT licensed. The `cloud/` directory (billing, multi-org management) is source-visible under the CartCrft Cloud License v1.0. See [Cloud vs Self-host](/cloud-vs-selfhost/).
