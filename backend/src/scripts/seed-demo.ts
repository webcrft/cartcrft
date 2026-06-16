/**
 * seed-demo.ts — Idempotent demo data seeder.
 *
 * Creates:
 *   - 1 platform user (DEMO_ADMIN_*)  + org
 *   - 1 super-admin  (DEMO_SUPERADMIN_*)
 *   - 1 demo store   "Lekki Threads"  (ZAR / Africa/Johannesburg)
 *   - 12 products with variants
 *   - 2 collections
 *   - 6 customers
 *   - 8 orders in varied statuses
 *   - 2 discount codes
 *   - inventory levels via a seeded warehouse
 *
 * Usage:
 *   pnpm --filter backend exec tsx src/scripts/seed-demo.ts
 */

import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword } from "../modules/account/service.js";
import { hashSuperAdminPassword } from "../lib/superadmin-auth.js";
import { encodeSecretValue } from "../lib/secrets.js";
import { randomBytes, randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/scripts/ → src/ → backend/ → repo root
const repoRoot = path.resolve(__dirname, "../../..");
dotenvConfig({ path: path.join(repoRoot, ".env"), override: false });

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── products fixture ─────────────────────────────────────────────────────────

const PRODUCTS = [
  {
    title: "Ankara Wrap Skirt",
    slug: "ankara-wrap-skirt",
    desc: "Bold geometric ankara print wrap skirt, midi length. Made in Lagos.",
    variants: [
      { title: "XS / Indigo", price: 649.00, sku: "AWS-XS-IND" },
      { title: "S / Indigo",  price: 649.00, sku: "AWS-S-IND"  },
      { title: "M / Indigo",  price: 649.00, sku: "AWS-M-IND"  },
      { title: "L / Burnt Orange", price: 649.00, sku: "AWS-L-BRN" },
    ],
  },
  {
    title: "Kente Pocket Square",
    slug: "kente-pocket-square",
    desc: "Hand-woven kente pocket square. Adds instant elegance to any suit.",
    variants: [
      { title: "Gold / Green", price: 189.00, sku: "KPS-GG" },
      { title: "Red / Black",  price: 189.00, sku: "KPS-RB" },
    ],
  },
  {
    title: "Dashiki Print Shirt",
    slug: "dashiki-print-shirt",
    desc: "Premium cotton dashiki shirt with hand-embroidered collar detail.",
    variants: [
      { title: "S", price: 799.00, sku: "DPS-S" },
      { title: "M", price: 799.00, sku: "DPS-M" },
      { title: "L", price: 799.00, sku: "DPS-L" },
      { title: "XL", price: 849.00, sku: "DPS-XL" },
    ],
  },
  {
    title: "Beaded Headband",
    slug: "beaded-headband",
    desc: "Handcrafted Zulu beadwork headband. Vibrant rainbow colour palette.",
    variants: [
      { title: "One Size", price: 249.00, sku: "BHB-OS" },
    ],
  },
  {
    title: "Shweshwe Tote Bag",
    slug: "shweshwe-tote-bag",
    desc: "Sturdy canvas tote lined with authentic three-cats shweshwe fabric.",
    variants: [
      { title: "Blue Print", price: 349.00, sku: "STB-BL" },
      { title: "Red Print",  price: 349.00, sku: "STB-RD" },
    ],
  },
  {
    title: "Leather Sandals",
    slug: "leather-sandals",
    desc: "Handmade Johannesburg cobbler sandals. Full-grain leather, adjustable strap.",
    variants: [
      { title: "Size 5", price: 1099.00, sku: "LS-05" },
      { title: "Size 6", price: 1099.00, sku: "LS-06" },
      { title: "Size 7", price: 1099.00, sku: "LS-07" },
      { title: "Size 8", price: 1099.00, sku: "LS-08" },
      { title: "Size 9", price: 1099.00, sku: "LS-09" },
    ],
  },
  {
    title: "Ndebele Wall Print",
    slug: "ndebele-wall-print",
    desc: "A3 Giclée art print inspired by Ndebele geometric mural painting.",
    variants: [
      { title: "A3 / Unframed", price: 429.00, sku: "NWP-A3" },
      { title: "A3 / Framed",   price: 699.00, sku: "NWP-A3-FR" },
    ],
  },
  {
    title: "Rooibos Body Scrub",
    slug: "rooibos-body-scrub",
    desc: "Exfoliating body scrub with Cederberg rooibos, raw sugar and shea butter.",
    variants: [
      { title: "200 g",   price: 289.00, sku: "RBS-200" },
      { title: "500 g",   price: 599.00, sku: "RBS-500" },
    ],
  },
  {
    title: "Maasai Bead Bracelet",
    slug: "maasai-bead-bracelet",
    desc: "Authentic Maasai seed-bead bracelet. Each piece is unique.",
    variants: [
      { title: "Slim / Red",    price: 149.00, sku: "MBB-S-RD" },
      { title: "Wide / Blue",   price: 199.00, sku: "MBB-W-BL" },
      { title: "Wide / Sunset", price: 199.00, sku: "MBB-W-SS" },
    ],
  },
  {
    title: "Bogolan Mud Cloth Pillow",
    slug: "bogolan-mud-cloth-pillow",
    desc: "45 × 45 cm throw pillow cover in hand-dyed Malian bogolan mud cloth.",
    variants: [
      { title: "Ivory / Black", price: 499.00, sku: "BCP-IB" },
      { title: "Terracotta",    price: 499.00, sku: "BCP-TC" },
    ],
  },
  {
    title: "Kikoy Beach Towel",
    slug: "kikoy-beach-towel",
    desc: "Traditional East African kikoy repurposed as a lightweight beach towel.",
    variants: [
      { title: "Turquoise",  price: 379.00, sku: "KBT-TQ" },
      { title: "Coral",      price: 379.00, sku: "KBT-CR" },
      { title: "Sand",       price: 379.00, sku: "KBT-SN" },
    ],
  },
  {
    title: "Calabash Serving Bowl",
    slug: "calabash-serving-bowl",
    desc: "Hand-carved and lacquered calabash bowl. Food safe. Ideal for salads & snacks.",
    variants: [
      { title: "Small (20 cm)",  price: 319.00, sku: "CSB-SM" },
      { title: "Large (30 cm)",  price: 519.00, sku: "CSB-LG" },
    ],
  },
];

const COLLECTIONS = [
  { title: "Summer Collection", slug: "summer-collection" },
  { title: "Bestsellers",       slug: "bestsellers"       },
];

const CUSTOMERS = [
  { first_name: "Thandiwe",  last_name: "Dlamini",   email: "thandiwe.dlamini@example.co.za"  },
  { first_name: "Sipho",     last_name: "Nkosi",     email: "sipho.nkosi@example.co.za"       },
  { first_name: "Aisha",     last_name: "Okonkwo",   email: "aisha.okonkwo@example.ng"        },
  { first_name: "Kwame",     last_name: "Asante",    email: "kwame.asante@example.gh"         },
  { first_name: "Fatima",    last_name: "Mahomed",   email: "fatima.mahomed@example.co.za"    },
  { first_name: "Lebo",      last_name: "Mokoena",   email: "lebo.mokoena@example.co.za"      },
];

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const adminEmail = process.env["DEMO_ADMIN_EMAIL"];
  const adminPass  = process.env["DEMO_ADMIN_PASSWORD"];
  const saEmail    = process.env["DEMO_SUPERADMIN_EMAIL"];
  const saPass     = process.env["DEMO_SUPERADMIN_PASSWORD"];

  if (!adminEmail || !adminPass || !saEmail || !saPass) {
    console.error("Missing DEMO_ADMIN_* or DEMO_SUPERADMIN_* env vars");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // ── 1. Platform user (org owner) ────────────────────────────────────────
    console.log("\n[1] Platform user …");
    let orgId: string;
    const existing = await client.query<{ id: string; org_id: string }>(
      `SELECT id::text, org_id::text FROM platform_users WHERE lower(email) = lower($1) LIMIT 1`,
      [adminEmail]
    );
    if (existing.rows[0]) {
      orgId = existing.rows[0].org_id;
      console.log(`    ✓ exists — org_id=${orgId}`);
    } else {
      orgId = randomUUID();
      const pwHash = hashPassword(adminPass);
      await client.query(
        `INSERT INTO platform_users (org_id, email, password_hash, role)
         VALUES ($1::uuid, $2, $3, 'owner')`,
        [orgId, adminEmail, pwHash]
      );
      console.log(`    ✓ created — org_id=${orgId}`);
    }

    // ── 2. Super-admin ───────────────────────────────────────────────────────
    console.log("\n[2] Super-admin …");
    const saHash = hashSuperAdminPassword(saPass);
    await client.query(
      `INSERT INTO super_admins (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = $2, updated_at = now()`,
      [saEmail, saHash]
    );
    console.log(`    ✓ upserted`);

    // ── 3. Demo store ────────────────────────────────────────────────────────
    console.log("\n[3] Store …");
    let storeId: string;
    const storeSlug = "lekki-threads";
    const storeRow = await client.query<{ id: string }>(
      `SELECT id::text FROM stores WHERE organization_id = $1::uuid AND slug = $2`,
      [orgId, storeSlug]
    );
    if (storeRow.rows[0]) {
      storeId = storeRow.rows[0].id;
      console.log(`    ✓ exists — id=${storeId}`);
    } else {
      const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
      const jwtSecret = randomBytes(32).toString("hex");
      const encodedJwtSecret = encodeSecretValue(jwtSecret, secretsKey) ?? jwtSecret;
      const res = await client.query<{ id: string }>(
        `INSERT INTO stores
           (organization_id, name, slug, currency, timezone, weight_unit,
            enable_currency_conversion, metadata, auth_enabled, auth_jwt_secret)
         VALUES
           ($1::uuid, $2, $3, 'ZAR', 'Africa/Johannesburg', 'g',
            false, '{}', false, $4)
         RETURNING id::text`,
        [orgId, "Lekki Threads", storeSlug, encodedJwtSecret]
      );
      storeId = res.rows[0]!.id;
      console.log(`    ✓ created — id=${storeId}`);
    }

    // ── 4. Products ──────────────────────────────────────────────────────────
    console.log("\n[4] Products …");
    const variantIds: string[] = [];
    const variants: { id: string; title: string; price: number; sku: string; product: string }[] = [];
    for (const p of PRODUCTS) {
      const prodRes = await client.query<{ id: string }>(
        `INSERT INTO products (store_id, title, slug, description, type, status)
         VALUES ($1::uuid, $2, $3, $4, 'simple', 'active')
         ON CONFLICT (store_id, slug) DO UPDATE SET updated_at = now()
         RETURNING id::text`,
        [storeId, p.title, p.slug, p.desc]
      );
      const productId = prodRes.rows[0]!.id;
      for (const v of p.variants) {
        // Check if variant with this sku already exists for this product
        const existV = await client.query<{ id: string }>(
          `SELECT id::text FROM product_variants WHERE product_id = $1::uuid AND sku = $2 LIMIT 1`,
          [productId, v.sku]
        );
        let vid: string;
        if (existV.rows[0]) {
          vid = existV.rows[0].id;
        } else {
          const vRes = await client.query<{ id: string }>(
            `INSERT INTO product_variants (product_id, title, price, sku)
             VALUES ($1::uuid, $2, $3, $4)
             RETURNING id::text`,
            [productId, v.title, v.price, v.sku]
          );
          vid = vRes.rows[0]!.id;
        }
        variantIds.push(vid);
        variants.push({ id: vid, title: v.title, price: v.price, sku: v.sku, product: p.title });
      }
    }
    console.log(`    ✓ ${PRODUCTS.length} products, ${variantIds.length} variants`);

    // ── 5. Collections ───────────────────────────────────────────────────────
    console.log("\n[5] Collections …");
    for (const col of COLLECTIONS) {
      await client.query(
        `INSERT INTO collections (store_id, title, slug, is_active)
         VALUES ($1::uuid, $2, $3, true)
         ON CONFLICT (store_id, slug) DO NOTHING`,
        [storeId, col.title, col.slug]
      );
    }
    console.log(`    ✓ ${COLLECTIONS.length} collections`);

    // ── 6. Customers ─────────────────────────────────────────────────────────
    console.log("\n[6] Customers …");
    const customerIds: string[] = [];
    for (const c of CUSTOMERS) {
      const res = await client.query<{ id: string }>(
        `INSERT INTO customers
           (store_id, email, first_name, last_name, auth_provider)
         VALUES ($1::uuid, $2, $3, $4, 'email')
         ON CONFLICT (store_id, email) DO UPDATE SET updated_at = now()
         RETURNING id::text`,
        [storeId, c.email, c.first_name, c.last_name]
      );
      customerIds.push(res.rows[0]!.id);
    }
    console.log(`    ✓ ${customerIds.length} customers`);

    // ── 7. Warehouse (needed for inventory) ──────────────────────────────────
    console.log("\n[7] Warehouse …");
    let warehouseId: string;
    const whRow = await client.query<{ id: string }>(
      `SELECT id::text FROM warehouses WHERE store_id = $1::uuid LIMIT 1`,
      [storeId]
    );
    if (whRow.rows[0]) {
      warehouseId = whRow.rows[0].id;
      console.log(`    ✓ exists — id=${warehouseId}`);
    } else {
      const whRes = await client.query<{ id: string }>(
        `INSERT INTO warehouses (store_id, name, code, is_active, is_default)
         VALUES ($1::uuid, 'Lekki HQ', 'LKK', true, true)
         RETURNING id::text`,
        [storeId]
      );
      warehouseId = whRes.rows[0]!.id;
      console.log(`    ✓ created — id=${warehouseId}`);
    }

    // ── 8. Inventory levels ──────────────────────────────────────────────────
    console.log("\n[8] Inventory levels …");
    let invCount = 0;
    for (const vid of variantIds) {
      await client.query(
        `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (variant_id, warehouse_id) DO UPDATE
           SET quantity_on_hand = EXCLUDED.quantity_on_hand`,
        [vid, warehouseId, Math.floor(Math.random() * 50) + 10]
      );
      invCount++;
    }
    console.log(`    ✓ ${invCount} inventory levels`);

    // ── 9. Orders ────────────────────────────────────────────────────────────
    console.log("\n[9] Orders …");
    type OrderSpec = {
      status: string;
      financial_status: string;
      fulfillment_status: string;
      subtotal: number;
      total: number;
      is_test: boolean;
    };
    const orderSpecs: OrderSpec[] = [
      { status: "open",      financial_status: "pending",  fulfillment_status: "unfulfilled", subtotal: 649.00,  total: 649.00,  is_test: false },
      { status: "open",      financial_status: "paid",     fulfillment_status: "unfulfilled", subtotal: 1448.00, total: 1448.00, is_test: false },
      { status: "open",      financial_status: "paid",     fulfillment_status: "fulfilled",   subtotal: 799.00,  total: 799.00,  is_test: false },
      { status: "open",      financial_status: "paid",     fulfillment_status: "fulfilled",   subtotal: 2197.00, total: 2197.00, is_test: false },
      { status: "cancelled", financial_status: "voided",   fulfillment_status: "unfulfilled", subtotal: 349.00,  total: 349.00,  is_test: false },
      { status: "open",      financial_status: "refunded", fulfillment_status: "returned",    subtotal: 1099.00, total: 1099.00, is_test: false },
      { status: "open",      financial_status: "paid",     fulfillment_status: "fulfilled",   subtotal: 938.00,  total: 938.00,  is_test: true  },
      { status: "open",      financial_status: "pending",  fulfillment_status: "unfulfilled", subtotal: 499.00,  total: 499.00,  is_test: false },
    ];
    let ordersCreated = 0;
    let orderLinesCreated = 0;
    for (let i = 0; i < orderSpecs.length; i++) {
      const spec = orderSpecs[i]!;
      const cust = customerIds[i % customerIds.length]!;

      // Build 1–3 realistic line items from the seeded variants.
      const lineCount = variants.length ? 1 + (i % 3) : 0;
      const start = variants.length ? (i * 2) % variants.length : 0;
      const lines: { variant: typeof variants[number]; qty: number; total: number }[] = [];
      for (let j = 0; j < lineCount; j++) {
        const variant = variants[(start + j) % variants.length]!;
        const qty = 1 + ((i + j) % 2); // 1 or 2
        lines.push({ variant, qty, total: +(variant.price * qty).toFixed(2) });
      }
      const subtotal = lines.length
        ? +lines.reduce((s, l) => s + l.total, 0).toFixed(2)
        : spec.subtotal;

      // Get next order number via DB function
      const numRes = await client.query<{ next_order_number: string }>(
        `SELECT next_order_number($1::uuid) AS next_order_number`,
        [storeId]
      );
      const orderNumber = numRes.rows[0]!.next_order_number;
      const orderRes = await client.query<{ id: string }>(
        `INSERT INTO orders
           (store_id, customer_id, order_number, status, financial_status,
            fulfillment_status, currency, subtotal, shipping_total, tax_total,
            discount_total, total, is_test)
         VALUES
           ($1::uuid, $2::uuid, $3, $4, $5, $6, 'ZAR', $7, 0, 0, 0, $8, $9)
         ON CONFLICT (store_id, order_number) DO NOTHING
         RETURNING id::text`,
        [storeId, cust, orderNumber, spec.status, spec.financial_status,
         spec.fulfillment_status, subtotal, subtotal, spec.is_test]
      );
      ordersCreated++;

      const orderId = orderRes.rows[0]?.id;
      if (orderId) {
        // A "fulfilled" order has fully-fulfilled lines; everything else unfulfilled.
        const lineFulfillment =
          spec.fulfillment_status === "fulfilled" ? "fulfilled" : "unfulfilled";
        for (const l of lines) {
          await client.query(
            `INSERT INTO order_lines
               (order_id, variant_id, title, sku, quantity, quantity_fulfilled,
                price, total, fulfillment_status)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
            [
              orderId,
              l.variant.id,
              `${l.variant.product} — ${l.variant.title}`,
              l.variant.sku,
              l.qty,
              lineFulfillment === "fulfilled" ? l.qty : 0,
              l.variant.price,
              l.total,
              lineFulfillment,
            ]
          );
          orderLinesCreated++;
        }
      }
    }
    console.log(`    ✓ ${ordersCreated} orders, ${orderLinesCreated} line items`);

    // ── 10. Discount codes ───────────────────────────────────────────────────
    console.log("\n[10] Discount codes …");
    const discounts = [
      { code: "LEKKI10", type: "percentage",   value: 10.00 },
      { code: "FLAT50",  type: "fixed_amount", value: 50.00 },
    ];
    for (const d of discounts) {
      await client.query(
        `INSERT INTO discount_codes (store_id, code, type, value, is_active)
         VALUES ($1::uuid, $2, $3, $4, true)
         ON CONFLICT (store_id, code) DO NOTHING`,
        [storeId, d.code, d.type, d.value]
      );
    }
    console.log(`    ✓ ${discounts.length} discount codes`);

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Seed complete!");
    console.log(`  org_id  : ${orgId}`);
    console.log(`  store_id: ${storeId}`);
    console.log(`  Admin   : ${adminEmail}`);
    console.log(`  SA      : ${saEmail}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("seed-demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
