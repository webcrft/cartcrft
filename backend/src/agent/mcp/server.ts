/**
 * agent/mcp/server.ts — Cartcrft MCP Server
 *
 * Exposes 9 commerce tools over the MCP protocol:
 *   search_products, get_product, create_cart, add_to_cart, get_cart,
 *   start_checkout, update_checkout, complete_checkout, get_order_status
 *
 * Auth: cc_pub_ key in Authorization header or ?key= query param.
 * Context: storeId is embedded in the path (/mcp/:storeId) so the server
 * instance is per-store and all tools are automatically scoped.
 *
 * Transport: caller mounts this via buildMcpServer(storeId) and connects
 * a StreamableHTTPServerTransport or StdioServerTransport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPool } from "../../db/pool.js";
import {
  createCart,
  getCart,
  addCartLine,
} from "../../modules/carts/service.js";
import {
  createCheckout,
  getCheckout,
  updateCheckout,
} from "../../modules/checkout/service.js";
import { completeCheckout } from "../../modules/checkout/complete.js";
import { getOrder } from "../../modules/orders/service.js";

// ── Tool result helpers ───────────────────────────────────────────────────────

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string, code?: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code: code ?? "TOOL_ERROR", message } }),
      },
    ],
  };
}

function notFound(resource: string) {
  return fail(`${resource} not found`, "NOT_FOUND");
}

/** Strip undefined values — required for exactOptionalPropertyTypes compatibility */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

// ── MCP server factory ────────────────────────────────────────────────────────

/**
 * Build a per-store McpServer instance with all 9 tools registered.
 * The storeId is baked into every service call — no tool receives it as an argument.
 */
export function buildMcpServer(storeId: string): McpServer {
  const server = new McpServer(
    {
      name: "cartcrft",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Cartcrft commerce tools. Use search_products to discover items, " +
        "create_cart/add_to_cart to build a basket, start_checkout/update_checkout " +
        "to set address+shipping, complete_checkout to place the order (test mode), " +
        "and get_order_status to check the result.",
    }
  );

  // ── 1. search_products ─────────────────────────────────────────────────────

  server.tool(
    "search_products",
    "Search the store catalog. Returns matching products with variants and prices.",
    {
      query: z
        .string()
        .optional()
        .describe("Free-text search term (ILIKE on title/description/vendor)"),
      status: z
        .enum(["active", "draft", "archived"])
        .optional()
        .describe("Filter by product status (default: active)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default: 10)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset (default: 0)"),
    },
    async (args) => {
      try {
        const pool = getPool();
        const query = args.query?.trim() ?? "";
        const status = args.status ?? "active";
        const limit = args.limit ?? 10;
        const offset = args.offset ?? 0;

        const params: unknown[] = [storeId, status, limit, offset];
        let searchClause = "";
        if (query) {
          params.push(`%${query}%`);
          const n = params.length;
          searchClause = ` AND (p.title ILIKE $${n} OR p.description ILIKE $${n} OR p.vendor ILIKE $${n})`;
        }

        const { rows: products } = await pool.query(
          `SELECT
             p.id::text, p.title, p.slug, p.description, p.type, p.status,
             p.vendor, p.seo_title, p.seo_desc, p.created_at,
             COALESCE(
               json_agg(
                 jsonb_build_object(
                   'id', pv.id::text,
                   'title', pv.title,
                   'sku', pv.sku,
                   'price', pv.price::text,
                   'compare_at_price', pv.compare_at_price::text,
                   'is_active', pv.is_active,
                   'track_inventory', pv.track_inventory
                 ) ORDER BY pv.position, pv.created_at
               ) FILTER (WHERE pv.id IS NOT NULL),
               '[]'
             ) AS variants
           FROM products p
           LEFT JOIN product_variants pv ON pv.product_id = p.id
           WHERE p.store_id = $1::uuid AND p.status = $2${searchClause}
           GROUP BY p.id
           ORDER BY p.created_at DESC
           LIMIT $3 OFFSET $4`,
          params
        );

        return ok({ products, total: products.length, offset, limit });
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "search failed",
          "SEARCH_ERROR"
        );
      }
    }
  );

  // ── 2. get_product ────────────────────────────────────────────────────────

  server.tool(
    "get_product",
    "Get full product details including variants, options, and media.",
    {
      product_id: z.string().describe("Product UUID"),
    },
    async (args) => {
      try {
        const { getProduct } = await import(
          "../../modules/catalog/service.js"
        );
        const product = await getProduct(storeId, args.product_id);
        if (!product) return notFound("product");
        return ok(product);
      } catch (err) {
        return fail(err instanceof Error ? err.message : "get_product failed");
      }
    }
  );

  // ── 3. create_cart ────────────────────────────────────────────────────────

  server.tool(
    "create_cart",
    "Create a new shopping cart. Returns the cart_id to use in subsequent calls.",
    {
      currency: z
        .string()
        .length(3)
        .optional()
        .describe("ISO 4217 currency code (defaults to store currency)"),
    },
    async (args) => {
      try {
        // Build opts without undefined values (exactOptionalPropertyTypes constraint)
        const opts: { currency?: string } = {};
        if (args.currency !== undefined) opts.currency = args.currency;
        const cartId = await createCart(storeId, opts);
        const cart = await getCart(storeId, cartId);
        return ok({ cart_id: cartId, cart });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "create_cart failed");
      }
    }
  );

  // ── 4. add_to_cart ────────────────────────────────────────────────────────

  server.tool(
    "add_to_cart",
    "Add a product variant to the cart. If the variant is already in the cart, its quantity is incremented.",
    {
      cart_id: z.string().describe("Cart UUID from create_cart"),
      variant_id: z.string().describe("Product variant UUID"),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe("Number of units to add"),
    },
    async (args) => {
      try {
        const lineId = await addCartLine(
          storeId,
          args.cart_id,
          args.variant_id,
          args.quantity
        );
        const cart = await getCart(storeId, args.cart_id);
        return ok({ line_id: lineId, cart });
      } catch (err) {
        const code =
          err instanceof Error &&
          "code" in err &&
          typeof (err as NodeJS.ErrnoException).code === "string"
            ? (err as NodeJS.ErrnoException).code ?? "TOOL_ERROR"
            : "TOOL_ERROR";
        return fail(err instanceof Error ? err.message : "add_to_cart failed", code);
      }
    }
  );

  // ── 5. get_cart ───────────────────────────────────────────────────────────

  server.tool(
    "get_cart",
    "Retrieve a cart with all its lines, quantities, and prices.",
    {
      cart_id: z.string().describe("Cart UUID"),
    },
    async (args) => {
      try {
        const cart = await getCart(storeId, args.cart_id);
        if (!cart) return notFound("cart");
        return ok(cart);
      } catch (err) {
        return fail(err instanceof Error ? err.message : "get_cart failed");
      }
    }
  );

  // ── 6. start_checkout ─────────────────────────────────────────────────────

  server.tool(
    "start_checkout",
    "Create a checkout session from a cart. Calculates taxes and validates the cart. Returns a checkout_id.",
    {
      cart_id: z.string().describe("Cart UUID from create_cart"),
      email: z
        .string()
        .email()
        .optional()
        .describe("Customer email address"),
      shipping_address: z
        .object({
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          address1: z.string().optional(),
          address2: z.string().optional(),
          city: z.string().optional(),
          province: z.string().optional(),
          province_code: z.string().optional(),
          country: z.string().optional(),
          country_code: z.string().optional(),
          zip: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional()
        .describe("Shipping address"),
    },
    async (args) => {
      try {
        const body: {
          cart_id: string;
          email?: string;
          shipping_address?: Record<string, unknown>;
        } = { cart_id: args.cart_id };
        if (args.email !== undefined) body.email = args.email;
        if (args.shipping_address !== undefined) {
          body.shipping_address = args.shipping_address as Record<string, unknown>;
        }
        const checkout = await createCheckout(storeId, body);
        return ok(checkout);
      } catch (err) {
        const code =
          err instanceof Error &&
          "code" in err &&
          typeof (err as NodeJS.ErrnoException).code === "string"
            ? (err as NodeJS.ErrnoException).code ?? "TOOL_ERROR"
            : "TOOL_ERROR";
        return fail(
          err instanceof Error ? err.message : "start_checkout failed",
          code
        );
      }
    }
  );

  // ── 7. update_checkout ────────────────────────────────────────────────────

  server.tool(
    "update_checkout",
    "Update a checkout with email, shipping address, billing address, or discount code. Recalculates totals.",
    {
      checkout_id: z.string().describe("Checkout UUID from start_checkout"),
      email: z.string().email().optional().describe("Customer email"),
      shipping_address: z
        .object({
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          address1: z.string().optional(),
          address2: z.string().optional(),
          city: z.string().optional(),
          province: z.string().optional(),
          province_code: z.string().optional(),
          country: z.string().optional(),
          country_code: z.string().optional(),
          zip: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional()
        .describe("Shipping address"),
      billing_address: z
        .object({
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          address1: z.string().optional(),
          address2: z.string().optional(),
          city: z.string().optional(),
          province: z.string().optional(),
          province_code: z.string().optional(),
          country: z.string().optional(),
          country_code: z.string().optional(),
          zip: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional()
        .describe("Billing address (defaults to shipping address if omitted)"),
      discount_code: z
        .string()
        .optional()
        .describe("Discount code to apply (uppercase; validates only — burns at complete time)"),
    },
    async (args) => {
      try {
        // Build update body without undefined values (exactOptionalPropertyTypes)
        const body: {
          email?: string;
          shipping_address?: Record<string, unknown>;
          billing_address?: Record<string, unknown>;
          discount_code?: string;
        } = {};
        if (args.email !== undefined) body.email = args.email;
        if (args.shipping_address !== undefined) {
          body.shipping_address = args.shipping_address as Record<string, unknown>;
        }
        if (args.billing_address !== undefined) {
          body.billing_address = args.billing_address as Record<string, unknown>;
        }
        if (args.discount_code !== undefined) body.discount_code = args.discount_code;

        const result = await updateCheckout(storeId, args.checkout_id, body);
        // Fetch the updated checkout for full context
        const checkout = await getCheckout(storeId, args.checkout_id);
        return ok({ ...result, checkout });
      } catch (err) {
        const code =
          err instanceof Error &&
          "code" in err &&
          typeof (err as NodeJS.ErrnoException).code === "string"
            ? (err as NodeJS.ErrnoException).code ?? "TOOL_ERROR"
            : "TOOL_ERROR";
        return fail(
          err instanceof Error ? err.message : "update_checkout failed",
          code
        );
      }
    }
  );

  // ── 8. complete_checkout ──────────────────────────────────────────────────

  server.tool(
    "complete_checkout",
    "Complete a checkout and create an order. This is the final purchase step. Works in test mode (no real payment required). Returns the order ID and order number.",
    {
      checkout_id: z.string().describe("Checkout UUID from start_checkout"),
    },
    async (args) => {
      try {
        const result = await completeCheckout(storeId, args.checkout_id);
        return ok({
          order_id: result.orderId,
          order_number: result.orderNumber,
          currency: result.currency,
          total: result.total.toFixed(2),
          item_count: result.itemCount,
          message: "Order created successfully",
        });
      } catch (err) {
        const code =
          err instanceof Error &&
          "code" in err &&
          typeof (err as NodeJS.ErrnoException).code === "string"
            ? (err as NodeJS.ErrnoException).code ?? "TOOL_ERROR"
            : "TOOL_ERROR";
        return fail(
          err instanceof Error ? err.message : "complete_checkout failed",
          code
        );
      }
    }
  );

  // ── 9. get_order_status ───────────────────────────────────────────────────

  server.tool(
    "get_order_status",
    "Get the current status and details of an order after checkout. Includes financial_status, fulfillment_status, line items, and payments.",
    {
      order_id: z.string().describe("Order UUID returned by complete_checkout"),
    },
    async (args) => {
      try {
        const order = await getOrder(args.order_id, storeId);
        if (!order) return notFound("order");
        return ok(order);
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "get_order_status failed"
        );
      }
    }
  );

  return server;
}
