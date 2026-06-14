---
title: "How Cartcrft compares"
description: "A grounded comparison of Cartcrft vs Shopify, Medusa v2, Vendure, Saleor, Swell, and WooCommerce across licensing, pricing, agent-native capabilities, and commerce features."
updatedDate: "2026-06-14"
methodology: "Pricing and feature status verified June 2026 from official pricing pages and documentation. Commerce capabilities are assessed against each platform's documented defaults — plugins and custom integrations are noted where relevant. Verify current figures before making decisions."
---

## Introduction

A straight-line comparison of licensing, pricing, agent-native capabilities, and commerce features across the major open-source and SaaS headless commerce platforms. We aim to be fair — this is not a strawman. Where competitors lead (Shopify on live agentic payments, for example), we say so.

## Cartcrft vs Shopify

Shopify is the undisputed scale leader and, since January 2026, a genuine agentic commerce player — their Storefront MCP server is live and US merchants can accept purchases through ChatGPT's Buy flow (published April 30, 2026). On agent-native, Shopify moves fast and has distribution.

The trade-offs: Shopify is closed-source and SaaS-only. External payment gateways incur a 0.6%–2% transaction surcharge per plan (as of June 2026), on top of your gateway's own fees. B2B features require Shopify Plus ($2,300+/mo). You cannot self-host, inspect the code, or bring your own infrastructure. Cartcrft's live agentic payments are still in development — if ChatGPT Instant Checkout today matters to you, Shopify is ahead. If owning your stack matters, Cartcrft is the answer.

## Cartcrft vs Medusa v2

Medusa is the closest OSS peer: MIT-licensed, TypeScript, headless-first, 0% GMV fees. Medusa Cloud starts at $29/mo (Develop tier, as of June 2026). Medusa has a large community, a plugin ecosystem, and a proven track record.

Where Cartcrft differs: agent-native is built into the core. Medusa has no MCP server, no ACP/UCP adapters, and no signed mandate layer — these would require custom integrations. Cartcrft also ships 4 payment providers (including Paystack and Razorpay for non-Western markets), lot tracking/FEFO inventory, and built-in pgvector semantic search. Medusa's module system gives more flexibility at the cost of more assembly.

## Cartcrft vs Vendure

Vendure is a TypeScript-first, GraphQL-native headless platform — well-architected and production-proven. The core is GPLv3; commercial features (storefront, enterprise plugins, dedicated support) require the commercial Platform tier. Vendure Cloud is in design-partner phase as of June 2026 (GA expected Q4 2026).

If your team prefers GraphQL over REST, Vendure is a strong option. Cartcrft is REST/OpenAPI with a generated TS SDK, which integrates naturally with agent tooling that expects structured REST endpoints. Neither platform has live agentic payments yet, but Cartcrft ships ACP/UCP adapters out of the box.

## Cartcrft vs Saleor

Saleor is open-source (BSD-3-Clause) and GraphQL-native. The self-hosted core is free and permissively licensed. Saleor Cloud, however, is positioned as an enterprise managed service: the entry Select plan starts at $1,599/mo (June 2026) with a GMV cap and 0.8% overage fee. For teams that want managed hosting, the cost cliff is steep.

Cartcrft and Saleor overlap on headless-first, open-source credentials. Cartcrft adds agent-native (MCP/ACP/UCP/mandates), REST API, TypeScript end-to-end, and built-in pgvector search. Saleor offers a mature GraphQL API and an established plugin marketplace.

## Cartcrft vs Swell

Swell is a closed-source, cloud-only headless commerce SaaS. The Starter plan is $29/mo (billed annually, as of June 2026) but includes revenue ceilings and overage fees (2% above $50K for Starter). You cannot self-host or inspect the source code.

Swell has a developer-friendly API and solid subscription support. If managed SaaS with per-revenue pricing is acceptable, Swell competes at the low end. If you want open source, self-hosting, zero transaction rake, and agent-native capabilities, Cartcrft is the different-category choice.

## Cartcrft vs WooCommerce

WooCommerce is GPL-licensed, free, self-hosted, and runs on WordPress + MySQL/MariaDB. It has the largest merchant install base of any ecommerce platform and an enormous plugin ecosystem. WooCommerce itself charges 0% transaction fees.

WooCommerce is PHP-first, WordPress-coupled, and not designed for headless or agent-native use cases. Advanced features (subscriptions, B2B, headless) require paid plugins. There is no MCP server, no ACP/UCP, no pgvector. Cartcrft is a different category: API-first, TypeScript, agent-native by design.

## Sources

**Sources and dates (all verified June 2026):**
Shopify plan pricing and external gateway fees from shopify.com/pricing (Basic $29/mo, external gateway surcharge 0.6%–2% depending on plan);
Medusa Cloud pricing from medusajs.com/pricing/ (Develop $29/mo, Launch $99/mo, Scale $299/mo, 0% GMV);
Saleor Cloud pricing from saleor.io/pricing (Select $1,599/mo with GMV cap, 0.8% overage);
Swell pricing from swell.is/pricing (Starter $29/mo billed annually, revenue ceilings and overage apply);
Vendure license and Cloud status from vendure.io/pricing (GPLv3 core, Commercial Platform tier, Cloud GA Q4 2026);
WooCommerce from wordpress.org/plugins/woocommerce (GPL-2.0+, self-hosted, 0% WC transaction fees);
Shopify agentic commerce (MCP, ACP, UCP) from shopify.com/blog/how-agentic-commerce-works (published April 30, 2026).
Cartcrft ACP/UCP status from internal docs (docs/acp.md, docs/ucp.md): test mode shipped, live delegated payment in development (roadmap Phase H5).
Verify all figures directly with each vendor before making purchasing decisions.
