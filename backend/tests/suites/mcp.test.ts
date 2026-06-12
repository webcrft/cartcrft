/**
 * mcp.test.ts — MCP server conformance + purchase flow suite.
 *
 * Tests:
 *  1. Initialize handshake (tools capability advertised)
 *  2. tools/list — 9 tools with valid JSON Schemas
 *  3. Full purchase flow via MCP tool calls:
 *     search_products → get_product → create_cart → add_to_cart →
 *     get_cart → start_checkout → update_checkout → complete_checkout →
 *     get_order_status
 *  4. Auth rejection (no key, bad key, wrong store key)
 *  5. Not-found paths (get_cart unknown id, get_order_status unknown id)
 *
 * Transport: StreamableHTTPClientTransport against the harness HTTP server.
 * The test creates a store, issues API keys, seeds a product + variant,
 * then drives the full flow through MCP tool calls.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  mintJwt,
  createApiKey,
  insertProduct,
  insertVariant,
  post,
} from "../shared/helpers.js";

// ── Context ───────────────────────────────────────────────────────────────────

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create an MCP client connected to /mcp/:storeId with the given key. */
async function mcpClient(storeId: string, apiKey: string): Promise<Client> {
  const url = new URL(`${ctx.baseUrl}/mcp/${storeId}`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { authorization: `Bearer ${apiKey}` },
    },
  });
  const client = new Client(
    { name: "cartcrft-test-client", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

/** Call a tool and return the parsed JSON content (assumes text response). */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`Tool ${name} returned no content`);
  }
  const first = content[0];
  if (!first || first.type !== "text") {
    throw new Error(`Tool ${name} returned non-text content: ${JSON.stringify(first)}`);
  }
  return JSON.parse(first.text);
}

/** Setup: create org, store, API key, and seeded product + variant. */
async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  // Create store
  const storeRes = await post(
    ctx,
    "/commerce/stores",
    { name: "MCP Test Store", currency: "ZAR", timezone: "Africa/Johannesburg" },
    auth
  );
  expect(storeRes.status).toBe(201);
  const storeId = (storeRes.json as Record<string, unknown>)["id"] as string;
  expect(typeof storeId).toBe("string");

  // Issue a public API key (cc_pub_) with read scope
  const pubKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "public",
    scopes: ["commerce:read"],
  });

  // Issue a private API key with full scopes (needed for write ops through MCP)
  const prvKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });

  // Seed product + variant. Set status = 'active' so search_products finds it.
  const product = await insertProduct(ctx.pool, {
    storeId,
    title: "Artisan Coffee Mug",
    slug: `mug-${Math.random().toString(36).slice(2, 7)}`,
  });

  // Activate product (default is 'draft')
  await ctx.pool.query(
    `UPDATE products SET status = 'active' WHERE id = $1::uuid`,
    [product.id]
  );

  const variant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Default",
    price: "149.00",
  });

  // Disable inventory tracking so completeCheckout doesn't require inventory_levels rows.
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );

  return {
    storeId,
    pubKey,
    prvKey,
    product,
    variant,
    orgId,
    userId,
    token,
  };
}

// ── Describe blocks ───────────────────────────────────────────────────────────

describe("MCP initialize handshake", () => {
  it("connects and negotiates tools capability", async () => {
    const setup = await setupStore();
    const client = await mcpClient(setup.storeId, setup.pubKey);
    try {
      // If connect() succeeded, the server negotiated capabilities.
      const serverInfo = client.getServerVersion();
      expect(serverInfo).toBeDefined();
      expect(serverInfo?.name).toBe("cartcrft");
    } finally {
      await client.close();
    }
  });
});

describe("MCP tools/list", () => {
  it("returns 9 tools with valid JSON Schemas", async () => {
    const setup = await setupStore();
    const client = await mcpClient(setup.storeId, setup.pubKey);
    try {
      const { tools } = await client.listTools();

      const expectedTools = [
        "search_products",
        "get_product",
        "create_cart",
        "add_to_cart",
        "get_cart",
        "start_checkout",
        "update_checkout",
        "complete_checkout",
        "get_order_status",
      ];

      expect(tools).toHaveLength(9);

      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([...expectedTools].sort());

      // Verify each tool has a valid JSON Schema on inputSchema
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      await client.close();
    }
  });
});

describe("MCP auth rejection", () => {
  it("returns 401 when no key is provided", async () => {
    const setup = await setupStore();
    const url = new URL(`${ctx.baseUrl}/mcp/${setup.storeId}`);
    // Don't set auth header
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client(
      { name: "no-auth-client", version: "0.1.0" },
      { capabilities: {} }
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("returns 401 for an invalid key", async () => {
    const setup = await setupStore();
    const url = new URL(`${ctx.baseUrl}/mcp/${setup.storeId}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: "Bearer cc_pub_invalid_key" } },
    });
    const client = new Client(
      { name: "bad-key-client", version: "0.1.0" },
      { capabilities: {} }
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("returns 403 when key is for a different store", async () => {
    const setup1 = await setupStore();
    const setup2 = await setupStore();
    // Use setup1's key but setup2's storeId
    const url = new URL(`${ctx.baseUrl}/mcp/${setup2.storeId}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { authorization: `Bearer ${setup1.pubKey}` },
      },
    });
    const client = new Client(
      { name: "wrong-store-client", version: "0.1.0" },
      { capabilities: {} }
    );
    await expect(client.connect(transport)).rejects.toThrow();
  });
});

describe("MCP full purchase flow", () => {
  // State carried through the flow
  let storeSetup: Awaited<ReturnType<typeof setupStore>>;
  let client: Client;

  let cartId: string;
  let checkoutId: string;
  let orderId: string;

  beforeAll(async () => {
    storeSetup = await setupStore();
    // Use the private key so we can do write operations
    client = await mcpClient(storeSetup.storeId, storeSetup.prvKey);
  });

  afterAll(async () => {
    await client.close();
  });

  it("search_products — finds seeded active product", async () => {
    const result = await callTool(client, "search_products", {
      query: "Artisan Coffee",
      limit: 5,
    });
    const data = result as Record<string, unknown>;
    expect(Array.isArray(data["products"])).toBe(true);
    const products = data["products"] as Record<string, unknown>[];
    expect(products.length).toBeGreaterThan(0);

    const found = products.find(
      (p) =>
        typeof p["title"] === "string" &&
        (p["title"] as string).includes("Artisan Coffee")
    );
    expect(found).toBeDefined();
  });

  it("get_product — returns full product with variants", async () => {
    const result = await callTool(client, "get_product", {
      product_id: storeSetup.product.id,
    });
    const data = result as Record<string, unknown>;
    expect(data["id"]).toBe(storeSetup.product.id);
    expect(data["title"]).toBe("Artisan Coffee Mug");
    expect(Array.isArray(data["variants"])).toBe(true);
    const variants = data["variants"] as Record<string, unknown>[];
    expect(variants.length).toBeGreaterThan(0);
  });

  it("create_cart — creates a new cart", async () => {
    const result = await callTool(client, "create_cart", {});
    const data = result as Record<string, unknown>;
    expect(typeof data["cart_id"]).toBe("string");
    cartId = data["cart_id"] as string;
    expect(cartId).toBeTruthy();

    const cart = data["cart"] as Record<string, unknown>;
    expect(cart["store_id"]).toBe(storeSetup.storeId);
    expect(cart["status"]).toBe("active");
  });

  it("add_to_cart — adds variant to cart", async () => {
    const result = await callTool(client, "add_to_cart", {
      cart_id: cartId,
      variant_id: storeSetup.variant.id,
      quantity: 2,
    });
    const data = result as Record<string, unknown>;
    expect(typeof data["line_id"]).toBe("string");

    const cart = data["cart"] as Record<string, unknown>;
    const lines = cart["lines"] as Record<string, unknown>[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(1);
    expect(lines[0]?.["quantity"]).toBe(2);
    expect(lines[0]?.["variant_id"]).toBe(storeSetup.variant.id);
  });

  it("get_cart — retrieves cart with lines", async () => {
    const result = await callTool(client, "get_cart", { cart_id: cartId });
    const cart = result as Record<string, unknown>;
    expect(cart["id"]).toBe(cartId);
    expect(cart["status"]).toBe("active");
    const lines = cart["lines"] as Record<string, unknown>[];
    expect(lines.length).toBe(1);
    expect(lines[0]?.["price"]).toBe("149.00");
  });

  it("start_checkout — creates checkout from cart", async () => {
    const result = await callTool(client, "start_checkout", {
      cart_id: cartId,
      email: "agent@cartcrft-test.example.com",
      shipping_address: {
        first_name: "Agent",
        last_name: "Buyer",
        address1: "1 Test Street",
        city: "Cape Town",
        country_code: "ZA",
        zip: "8001",
      },
    });
    const data = result as Record<string, unknown>;
    // createCheckout returns { id, subtotal, shipping_total, tax_total,
    // discount_total, total, currency, tax_lines, discount_lines }
    expect(typeof data["id"]).toBe("string");
    checkoutId = data["id"] as string;
    expect(checkoutId).toBeTruthy();
    // subtotal = 2 × 149 = 298
    expect(parseFloat(data["subtotal"] as string)).toBeCloseTo(298, 0);
    expect(typeof data["currency"]).toBe("string");
  });

  it("update_checkout — sets billing address and email", async () => {
    const result = await callTool(client, "update_checkout", {
      checkout_id: checkoutId,
      email: "agent-updated@cartcrft-test.example.com",
      billing_address: {
        first_name: "Agent",
        last_name: "Buyer",
        address1: "1 Test Street",
        city: "Cape Town",
        country_code: "ZA",
        zip: "8001",
      },
    });
    const data = result as Record<string, unknown>;
    // subtotal should remain unchanged
    expect(parseFloat(data["subtotal"] as string)).toBeCloseTo(298, 0);
    // checkout field in response has updated email
    const checkout = data["checkout"] as Record<string, unknown>;
    if (checkout) {
      expect(checkout["email"]).toBe("agent-updated@cartcrft-test.example.com");
    }
  });

  it("complete_checkout — creates an order", async () => {
    const result = await callTool(client, "complete_checkout", {
      checkout_id: checkoutId,
    });
    const data = result as Record<string, unknown>;
    expect(typeof data["order_id"]).toBe("string");
    orderId = data["order_id"] as string;
    expect(orderId).toBeTruthy();
    expect(typeof data["order_number"]).toBe("string");
    expect(data["message"]).toBe("Order created successfully");
    // total > 0
    expect(parseFloat(data["total"] as string)).toBeGreaterThan(0);
    // item_count = 1 line
    expect(data["item_count"]).toBe(1);
  });

  it("get_order_status — returns the created order", async () => {
    const result = await callTool(client, "get_order_status", {
      order_id: orderId,
    });
    const order = result as Record<string, unknown>;
    expect(order["id"]).toBe(orderId);
    expect(order["status"]).toBe("open");
    expect(order["financial_status"]).toBe("pending");
    // Lines should include our variant
    const lines = order["lines"] as Record<string, unknown>[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(1);
    expect(lines[0]?.["variant_id"]).toBe(storeSetup.variant.id);
    expect(lines[0]?.["quantity"]).toBe(2);
  });
});

describe("MCP tool error cases", () => {
  let storeSetup: Awaited<ReturnType<typeof setupStore>>;
  let client: Client;

  beforeAll(async () => {
    storeSetup = await setupStore();
    client = await mcpClient(storeSetup.storeId, storeSetup.prvKey);
  });

  afterAll(async () => {
    await client.close();
  });

  it("get_cart returns NOT_FOUND for unknown id", async () => {
    const result = await callTool(client, "get_cart", {
      cart_id: randomUUID(),
    });
    const data = result as Record<string, unknown>;
    const error = data["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("NOT_FOUND");
  });

  it("get_product returns NOT_FOUND for unknown id", async () => {
    const result = await callTool(client, "get_product", {
      product_id: randomUUID(),
    });
    const data = result as Record<string, unknown>;
    const error = data["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("NOT_FOUND");
  });

  it("get_order_status returns NOT_FOUND for unknown id", async () => {
    const result = await callTool(client, "get_order_status", {
      order_id: randomUUID(),
    });
    const data = result as Record<string, unknown>;
    const error = data["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("NOT_FOUND");
  });

  it("add_to_cart returns error for unknown cart", async () => {
    const result = await callTool(client, "add_to_cart", {
      cart_id: randomUUID(),
      variant_id: randomUUID(),
      quantity: 1,
    });
    const data = result as Record<string, unknown>;
    // isError flag set, or error code in content
    const error = data["error"] as Record<string, unknown>;
    expect(error).toBeDefined();
    expect(["NOT_FOUND", "TOOL_ERROR"]).toContain(error["code"]);
  });

  it("complete_checkout returns error for non-existent checkout", async () => {
    const result = await callTool(client, "complete_checkout", {
      checkout_id: randomUUID(),
    });
    const data = result as Record<string, unknown>;
    const error = data["error"] as Record<string, unknown>;
    expect(error).toBeDefined();
    expect(["NOT_FOUND", "TOOL_ERROR"]).toContain(error["code"]);
  });
});

describe("MCP ?key= query param auth", () => {
  it("authenticates via query param instead of header", async () => {
    const setup = await setupStore();
    const url = new URL(
      `${ctx.baseUrl}/mcp/${setup.storeId}?key=${setup.pubKey}`
    );
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client(
      { name: "query-param-auth-client", version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(9);
    } finally {
      await client.close();
    }
  });
});
