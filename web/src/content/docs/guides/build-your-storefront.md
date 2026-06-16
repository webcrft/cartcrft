---
title: "Build your store frontend"
description: "Cartcrft is a headless backend — you bring your own storefront. This guide covers four ways to build and deploy a frontend against the Cartcrft REST API: WebCrft (visual, no-code), plain HTML/JS on free static hosting, a JavaScript framework with the @cartcrft/sdk, or an agent-native surface with no traditional UI at all."
---

# Build your store frontend

Cartcrft is a **headless commerce backend**. It handles products, inventory, carts, orders, payments, shipping, tax, agents, and every other commerce primitive — but it ships no storefront UI. You build (or skip) that part yourself.

This is intentional. Headless means your customer-facing presentation is completely under your control: you choose the framework, the hosting, and the design. Cartcrft exposes everything through a REST API and an `@cartcrft/sdk` TypeScript client so any frontend can connect.

---

## Choosing an approach

| Approach | Code required | Effort | Best for |
|---|---|---|---|
| [WebCrft (visual builder)](#1-webcrft-recommended) | None | Lowest | Merchants who want a beautiful storefront fast |
| [Static HTML + JS](#2-plain-html--javascript) | Basic HTML/JS | Low | Simple catalogues, landing pages, marketing sites |
| [JS framework (Next.js / Astro / etc.)](#3-javascript-framework) | Moderate | Medium | SEO-critical stores, complex catalogs, server rendering |
| [Agent-native / no frontend](#4-agent-native--no-traditional-frontend) | Minimal config | Low | LLM-first commerce, B2B bots, voice/chat commerce |

All four options authenticate via an API key that you create in **Store → API Keys** in the Cartcrft dashboard. Read-only storefront requests use a `cc_pub_` key (safe to embed in browser JavaScript). Server-side mutations use a `cc_prv_` key (keep secret, never ship to the browser).

---

## 1. WebCrft (recommended)

**[WebCrft](https://webcrft.io)** is the sister platform to Cartcrft. It is a visual storefront builder designed specifically to connect to a Cartcrft backend. You build your storefront pages, product grids, cart, and checkout UI in WebCrft's drag-and-drop editor, then wire it to your Cartcrft store with a single API key — no code required.

**Why WebCrft:**
- Built for Cartcrft's data model — products, variants, collections, and checkout links map 1:1.
- Visual editor with real-time preview.
- Handles hosting, CDN, and SSL.
- You own the design entirely.

### Steps

1. Create a free account at [webcrft.io](https://webcrft.io).
2. Create a new project and choose **"Connect to Cartcrft"**.
3. In your Cartcrft dashboard, go to **Store → API Keys** and generate a `cc_pub_` key.
4. Paste the key and your store's base URL (`https://api.cartcrft.dev` for cloud; your own host for self-hosted) into the WebCrft connection modal.
5. Build your storefront pages visually. WebCrft's data blocks pull live product data directly from your Cartcrft store.
6. Publish. WebCrft handles deployment and CDN.

For checkout, WebCrft uses Cartcrft's hosted checkout links — no payment-provider integration code is needed on your end.

---

## 2. Plain HTML + JavaScript

A hand-written static site is the simplest way to call the Cartcrft API. You write HTML, CSS, and vanilla JavaScript, call `GET /commerce/stores/:storeId/products` with a `cc_pub_` key, render the results into the DOM, and redirect customers to a checkout link for payment. There is nothing to compile or deploy — just upload files to a static host.

**Free static hosting options:** Firebase Hosting, Cloudflare Pages, Netlify, GitHub Pages.

### Getting a publishable key

In the Cartcrft dashboard: **Store → API Keys → New Key → Scopes: `commerce:read`**.

Copy the `cc_pub_` value — this is the only time it is shown in full.

### Listing products

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>My Store</title>
</head>
<body>
  <h1>Products</h1>
  <div id="products"></div>

  <script>
    const BASE_URL = 'https://api.cartcrft.dev'; // or your self-hosted URL
    const STORE_ID = 'YOUR_STORE_ID';
    const PUB_KEY  = 'cc_pub_YOUR_KEY_HERE';

    async function loadProducts() {
      const res = await fetch(
        `${BASE_URL}/commerce/stores/${STORE_ID}/products?limit=24`,
        { headers: { Authorization: `Bearer ${PUB_KEY}` } }
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const { products } = await res.json();

      const grid = document.getElementById('products');
      for (const p of products) {
        const card = document.createElement('div');
        card.innerHTML = `
          <h2>${p.title}</h2>
          <p>${p.description ?? ''}</p>
          <p><strong>${p.price_min ?? ''}</strong></p>
          <button data-id="${p.id}">Buy</button>
        `;
        grid.appendChild(card);
      }
    }

    loadProducts().catch(console.error);
  </script>
</body>
</html>
```

The response shape is `{ products: Product[], total: number }`. Each product has an `id`, `title`, `description`, `price_min`, `images`, and `variants` array.

### Sending a customer to checkout

For payment, generate a checkout link on your server (or via an edge function) using a `cc_prv_` key, then redirect the customer's browser to the returned URL:

```js
// Server-side / edge function only — do NOT call with cc_prv_ from the browser
async function createCheckoutLink(variantId, quantity) {
  const res = await fetch(
    `${BASE_URL}/commerce/stores/${STORE_ID}/checkout-links`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer cc_prv_YOUR_PRIVATE_KEY`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        line_items: [{ variant_id: variantId, quantity }],
        success_url: 'https://yoursite.com/thank-you',
        cancel_url:  'https://yoursite.com/store',
      }),
    }
  );
  const { url } = await res.json();
  return url; // e.g. https://pay.cartcrft.dev/pay/cl_...
}

// In your click handler (after fetching the link from your own API endpoint):
window.location.href = checkoutUrl;
```

The customer lands on Cartcrft's hosted checkout page (`/pay/cl_...`), completes payment through your connected provider, and is redirected back to your `success_url`.

> **Tip:** Never expose a `cc_prv_` key in browser JavaScript. Create a small serverless function (Cloudflare Worker, Netlify Function, Firebase Function) to generate checkout links and return only the URL to the browser.

### Deploy to Cloudflare Pages (example)

```bash
# From your project directory:
npx wrangler pages deploy . --project-name my-store
```

Firebase, Netlify, and GitHub Pages work similarly — point them at your HTML files. No build step required.

---

## 3. JavaScript Framework

For SEO-critical stores, complex catalogs, or server-rendered pages, use a JavaScript metaframework. Next.js, Astro, Remix, and SvelteKit all work well as storefronts against the Cartcrft API. Use the `@cartcrft/sdk` for typed, ergonomic access.

**Recommended hosting:** Vercel, Netlify, Cloudflare Pages (with Cloudflare Workers for server functions).

### Install the SDK

```bash
npm install @cartcrft/sdk
# or
pnpm add @cartcrft/sdk
```

### Initialise the client

```ts
// lib/cartcrft.ts
import { Cartcrft } from '@cartcrft/sdk';

// Public client — safe to use in Server Components and edge functions.
// Do not use cc_prv_ in client-side bundles.
export const storefront = new Cartcrft({
  baseUrl: process.env.CARTCRFT_BASE_URL ?? 'https://api.cartcrft.dev',
  apiKey: process.env.CARTCRFT_PUB_KEY, // cc_pub_...
});

// Private client — server-only, never bundled to the browser.
export const adminClient = new Cartcrft({
  baseUrl: process.env.CARTCRFT_BASE_URL ?? 'https://api.cartcrft.dev',
  apiKey: process.env.CARTCRFT_PRV_KEY, // cc_prv_...
});
```

### List products (Next.js App Router example)

```tsx
// app/products/page.tsx
import { storefront } from '@/lib/cartcrft';

const STORE_ID = process.env.CARTCRFT_STORE_ID!;

export default async function ProductsPage() {
  const { products } = await storefront.catalog.listProducts(STORE_ID, {
    limit: 24,
  });

  return (
    <main>
      <h1>Products</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            <a href={`/products/${p.id}`}>{p.title}</a>
            <span> — {p.price_min}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

### Create a checkout link (Next.js Server Action example)

```ts
// app/actions/checkout.ts
'use server';
import { adminClient } from '@/lib/cartcrft';

const STORE_ID = process.env.CARTCRFT_STORE_ID!;

export async function createCheckoutLink(variantId: string, quantity: number) {
  const result = await adminClient.request<{ url: string }>(
    `/commerce/stores/${STORE_ID}/checkout-links`,
    {
      method: 'POST',
      body: {
        line_items: [{ variant_id: variantId, quantity }],
        success_url: 'https://yoursite.com/thank-you',
        cancel_url:  'https://yoursite.com/products',
      },
    }
  );
  return result.url; // redirect the client to this URL
}
```

### Astro example

```astro
---
// src/pages/products/index.astro
import { storefront } from '../lib/cartcrft';
const STORE_ID = import.meta.env.CARTCRFT_STORE_ID;
const { products } = await storefront.catalog.listProducts(STORE_ID, { limit: 24 });
---

<html lang="en">
  <body>
    <h1>Products</h1>
    <ul>
      {products.map(p => (
        <li><a href={`/products/${p.id}`}>{p.title}</a></li>
      ))}
    </ul>
  </body>
</html>
```

Astro's static output mode (`output: 'static'`) pre-renders pages at build time for maximum performance. Use `output: 'server'` or `output: 'hybrid'` with an adapter (Cloudflare, Netlify, Vercel) for dynamic routes and server actions.

### Environment variables

```bash
# .env.local (Next.js / Astro / Remix / SvelteKit)
CARTCRFT_BASE_URL=https://api.cartcrft.dev
CARTCRFT_STORE_ID=your-store-id
CARTCRFT_PUB_KEY=cc_pub_...
CARTCRFT_PRV_KEY=cc_prv_...   # server-only, never expose to the client
```

---

## 4. Agent-native / no traditional frontend

Cartcrft is designed from the ground up for **LLM-first commerce**. Instead of building a UI at all, you can expose your store directly to AI agents via the built-in MCP server and the ACP/UCP adapters. The "storefront" is the agent surface itself.

This is the right approach for:
- **Conversational commerce** — a chatbot or voice assistant that lets customers buy through natural language.
- **B2B / procurement bots** — agents that run purchasing workflows without human UIs.
- **Agentic marketplaces** — AI agents that can discover, evaluate, and buy from your store autonomously.

### MCP server

Every Cartcrft store exposes an MCP (Model Context Protocol) endpoint. Any MCP-capable agent — Claude Desktop, Claude Code, a custom LLM pipeline — can connect and use tools to browse products, manage carts, and complete orders.

```
# HTTP/SSE transport (recommended)
POST/GET https://<host>/mcp/<storeId>
Authorization: Bearer cc_pub_<key>
```

```json
// Example: Claude Desktop mcp_servers config
{
  "cartcrft": {
    "url": "https://api.cartcrft.dev/mcp/YOUR_STORE_ID",
    "headers": { "Authorization": "Bearer cc_pub_..." }
  }
}
```

The MCP server exposes tools including `search_products`, `add_to_cart`, `get_cart`, `initiate_checkout`, and more. See the [Agent-native reference](/agent-native) for the full tool catalog.

### ACP adapter

The ACP (Agent Commerce Protocol) adapter provides a structured feed and checkout-session API designed for agent workflows:

```ts
import { Cartcrft } from '@cartcrft/sdk';

const sdk = new Cartcrft({
  baseUrl: 'https://api.cartcrft.dev',
  apiKey: 'cc_pub_YOUR_KEY',
});

// Browse the product feed
const { items } = await sdk.acp.getFeed('YOUR_STORE_ID', { limit: 20 });

// Create a checkout session for an agent-driven purchase
const session = await sdk.acp.createSession('YOUR_STORE_ID', {
  cart: { items: [{ variant_id: 'var_...', quantity: 1 }] },
});
```

See the [ACP adapter reference](/acp) for the full session lifecycle.

### Shareable checkout links as agent output

Agents that interact with human customers over chat or email can generate a checkout link and share it as a URL — the customer clicks it to complete payment in the hosted checkout page. No storefront UI required:

```ts
// Inside your agent's tool handler:
const { url } = await adminSdk.request('/commerce/stores/STORE_ID/checkout-links', {
  method: 'POST',
  body: {
    line_items: [{ variant_id: chosenVariantId, quantity: 1 }],
    customer_email: customerEmail,
    success_url: 'https://yoursite.com/thanks',
  },
});

// Agent responds to the user:
return `Here is your checkout link: ${url}`;
```

---

## Next steps

- [API overview](/api-overview) — authentication, error handling, pagination, and money encoding.
- [All endpoints](/parity-endpoints) — the full REST endpoint table.
- [Agent-native reference](/agent-native) — MCP tools, ACP/UCP adapters, mandates, and spend limits.
- [Checkout links](/checkout-links) — shareable payment links in depth.
- [BYO keys](/byo-keys) — connecting your own payment provider and LLM keys.
