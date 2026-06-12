/**
 * seed/index.ts — Cartcrft demo store seed script.
 *
 * Creates a complete "Crft Goods" demo store with:
 *  - 1 organization (uuid derived from slug) + 1 store (currency: USD)
 *  - 1 cc_pub_ key + 1 cc_prv_ key (printed once to stdout)
 *  - 12 products with rich structured attributes:
 *      - Apparel (hoodies, tees, beanies, socks) with size/colour options + variants
 *      - A digital download (design asset pack)
 *      - A bundle (starter kit)
 *      - A subscription-type product (coffee replenishment)
 *      - Accessories, home goods, outdoor gear, eco products
 *  - Prices + inventory in a default warehouse
 *  - 1 manual collection + 1 smart collection (active products)
 *  - Discount code WELCOME10 (10% off, no minimum)
 *  - Shipping zone (worldwide flat $7.99 + free over $100)
 *  - Tax zone example (US 0%)
 *
 * Modes:
 *  - `pnpm seed`  → runs against DATABASE_URL from root .env
 *  - `seedDemoStore(pool)` — exported function usable in tests/docker
 *
 * Idempotent: checks for existing store slug "crft-goods" and returns early
 * (alreadyExisted = true) if found.
 *
 * Never prints DATABASE_URL or any secret from .env.
 * Prints the generated cc_pub_ and cc_prv_ keys once.
 */

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeedResult {
  orgId: string;
  storeId: string;
  pubKey: string;
  prvKey: string;
  warehouseId: string;
  productIds: string[];
  variantIds: string[][];
  collectionId: string;
  smartCollectionId: string;
  discountId: string;
  shippingZoneId: string;
  alreadyExisted: boolean;
}

// ── Key generation helpers ─────────────────────────────────────────────────────

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function maskKey(raw: string): string {
  const prefix = raw.startsWith("cc_pub_")
    ? "cc_pub_"
    : raw.startsWith("cc_prv_")
      ? "cc_prv_"
      : "";
  const body = raw.slice(prefix.length);
  if (body.length <= 8) return raw;
  return `${prefix}${body.slice(0, 4)}...${body.slice(-4)}`;
}

function genKey(type: "public" | "private"): string {
  const prefix = type === "public" ? "cc_pub_" : "cc_prv_";
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

/**
 * Derive a deterministic UUIDv4-shaped string from a seed string.
 * Used so the demo org_id is stable across re-seeding.
 */
function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  // Format: 8-4-4-4-12, with version=4 and variant bits set
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16),                              // version 4
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + h.slice(18, 20), // variant
    h.slice(20, 32),
  ].join("-");
}

// ── Product definitions ─────────────────────────────────────────────────────────

interface ProductDef {
  title: string;
  slug: string;
  type: string;
  description: string;
  vendor: string;
  tags: string[];
  seo_title?: string;
  seo_desc?: string;
  variants: VariantDef[];
  options?: OptionDef[];
  /** Inventory qty per variant index (0 or absent = no level row) */
  inventory?: number[];
}

interface VariantDef {
  title: string;
  price: string;
  compare_at_price?: string;
  sku?: string;
  weight_g?: number;
  track_inventory?: boolean;
}

interface OptionDef {
  name: string;
  values: string[];
}

const PRODUCTS: ProductDef[] = [
  // ── 1. Merino Hoodie (apparel, configurable — size × colour) ───────────────
  {
    title: "Alpine Merino Pullover Hoodie",
    slug: "alpine-merino-pullover-hoodie",
    type: "configurable",
    description:
      "Crafted from 100% New Zealand merino wool (250 GSM midweight), this pullover hoodie " +
      "delivers natural temperature regulation on trails, in city coffee shops, and during cold-weather travel. " +
      "The relaxed fit accommodates layering, while the kangaroo pocket fits your phone and trail snacks. " +
      "Odour-resistant, machine-washable, and ethically sourced. " +
      "Best for: hiking, travel, remote work, weekend wear. " +
      "Materials: 100% merino wool, ribbed hem and cuffs.",
    vendor: "Crft Goods",
    tags: ["merino", "wool", "hoodie", "apparel", "outdoor", "travel", "sustainable"],
    seo_title: "Alpine Merino Pullover Hoodie | Crft Goods",
    seo_desc: "100% NZ merino wool hoodie, 250 GSM, odour-resistant. Perfect for hiking, travel, remote work. Free shipping over $100.",
    options: [
      { name: "Size",   values: ["XS", "S", "M", "L", "XL"] },
      { name: "Colour", values: ["Slate Grey", "Forest Green"] },
    ],
    variants: [
      { title: "XS / Slate Grey",   price: "89.00", compare_at_price: "109.00", sku: "AMH-XS-SG", weight_g: 320 },
      { title: "S / Slate Grey",    price: "89.00", compare_at_price: "109.00", sku: "AMH-S-SG",  weight_g: 340 },
      { title: "M / Slate Grey",    price: "89.00", compare_at_price: "109.00", sku: "AMH-M-SG",  weight_g: 360 },
      { title: "L / Slate Grey",    price: "89.00", compare_at_price: "109.00", sku: "AMH-L-SG",  weight_g: 380 },
      { title: "XL / Slate Grey",   price: "89.00", compare_at_price: "109.00", sku: "AMH-XL-SG", weight_g: 400 },
      { title: "S / Forest Green",  price: "89.00", compare_at_price: "109.00", sku: "AMH-S-FG",  weight_g: 340 },
      { title: "M / Forest Green",  price: "89.00", compare_at_price: "109.00", sku: "AMH-M-FG",  weight_g: 360 },
      { title: "L / Forest Green",  price: "89.00", compare_at_price: "109.00", sku: "AMH-L-FG",  weight_g: 380 },
      { title: "XL / Forest Green", price: "89.00", compare_at_price: "109.00", sku: "AMH-XL-FG", weight_g: 400 },
    ],
    inventory: [8, 15, 20, 14, 6, 18, 22, 12, 5],
  },

  // ── 2. Organic Tee (apparel, configurable) ────────────────────────────────
  {
    title: "Everyday Organic Cotton Tee",
    slug: "everyday-organic-cotton-tee",
    type: "configurable",
    description:
      "Unisex tee made from GOTS-certified organic cotton, garment-dyed in small batches for a " +
      "soft, lived-in feel from day one. 185 GSM mid-weight jersey. Ring-spun, combed, and reactive-dyed. " +
      "Shoulder seams tape-reinforced for lasting shape. " +
      "Best for: everyday wear, gifting, brand basics. " +
      "Care: cold wash, hang dry.",
    vendor: "Crft Goods",
    tags: ["tee", "organic", "cotton", "basics", "sustainable", "unisex"],
    options: [
      { name: "Size",   values: ["XS", "S", "M", "L", "XL"] },
      { name: "Colour", values: ["White", "Bone", "Washed Black"] },
    ],
    variants: [
      { title: "S / White",        price: "34.00", sku: "EOT-S-WH",  weight_g: 180 },
      { title: "M / White",        price: "34.00", sku: "EOT-M-WH",  weight_g: 200 },
      { title: "L / White",        price: "34.00", sku: "EOT-L-WH",  weight_g: 220 },
      { title: "XL / White",       price: "34.00", sku: "EOT-XL-WH", weight_g: 240 },
      { title: "S / Bone",         price: "34.00", sku: "EOT-S-BO",  weight_g: 180 },
      { title: "M / Bone",         price: "34.00", sku: "EOT-M-BO",  weight_g: 200 },
      { title: "L / Bone",         price: "34.00", sku: "EOT-L-BO",  weight_g: 220 },
      { title: "M / Washed Black", price: "34.00", sku: "EOT-M-BK",  weight_g: 200 },
      { title: "L / Washed Black", price: "34.00", sku: "EOT-L-BK",  weight_g: 220 },
    ],
    inventory: [25, 30, 25, 18, 20, 28, 22, 30, 24],
  },

  // ── 3. Merino Beanie (simple apparel) ─────────────────────────────────────
  {
    title: "Merino Ribbed Beanie",
    slug: "merino-ribbed-beanie",
    type: "simple",
    description:
      "2×2 rib-knit beanie in 100% fine merino wool (16 micron). " +
      "Naturally insulating, itch-free against skin, and packs flat into any jacket pocket. " +
      "One size fits most. " +
      "Materials: 100% merino wool. Washing: machine wash cold, lay flat to dry.",
    vendor: "Crft Goods",
    tags: ["merino", "wool", "beanie", "accessory", "winter", "outdoor"],
    options: [{ name: "Colour", values: ["Slate Grey", "Forest Green", "Midnight Navy"] }],
    variants: [
      { title: "Slate Grey",    price: "28.00", sku: "MRB-SG", weight_g: 80 },
      { title: "Forest Green",  price: "28.00", sku: "MRB-FG", weight_g: 80 },
      { title: "Midnight Navy", price: "28.00", sku: "MRB-MN", weight_g: 80 },
    ],
    inventory: [40, 35, 30],
  },

  // ── 4. Waxed Canvas Tote (accessory, simple) ──────────────────────────────
  {
    title: "Heritage Waxed Canvas Tote",
    slug: "heritage-waxed-canvas-tote",
    type: "simple",
    description:
      "Full-grain leather handles, 16 oz waxed cotton canvas body, and a brass YKK zipper. " +
      "Water-resistant wax coating re-applies with any food-grade beeswax. " +
      "Inside: 1 zipped pocket, 2 slip pockets, key clip. " +
      "Capacity: 25L. Dimensions: 40 × 35 × 15 cm. " +
      "Use-cases: farmers market, commute, weekend travel, grocery carry. " +
      "Materials: waxed cotton canvas, vegetable-tanned leather, solid brass hardware.",
    vendor: "Crft Goods",
    tags: ["tote", "bag", "canvas", "waxed", "leather", "accessory", "carry"],
    options: [{ name: "Colourway", values: ["Natural / Tan Leather", "Charcoal / Dark Leather"] }],
    variants: [
      { title: "Natural / Tan Leather",   price: "79.00", compare_at_price: "95.00", sku: "HWT-NT-TL", weight_g: 680 },
      { title: "Charcoal / Dark Leather", price: "79.00", compare_at_price: "95.00", sku: "HWT-CH-DL", weight_g: 690 },
    ],
    inventory: [18, 14],
  },

  // ── 5. Ceramic Pour-Over Set (home, simple) ───────────────────────────────
  {
    title: "Single-Origin Pour-Over Starter Set",
    slug: "single-origin-pour-over-starter-set",
    type: "simple",
    description:
      "Everything you need to brew café-quality filter coffee at home or in a studio. " +
      "Set includes: 1 × ceramic dripper (V60-compatible), 1 × 600 ml borosilicate glass carafe, " +
      "40 × unbleached paper filters, 1 × 35 g sample of Ethiopian Yirgacheffe. " +
      "Dripper material: high-fire stoneware, food-safe glaze, heat-rated to 280°C. " +
      "Best for: pour-over enthusiasts, coffee gifting, specialty coffee beginners.",
    vendor: "Crft Goods",
    tags: ["coffee", "pour-over", "ceramic", "home", "kitchen", "gift"],
    options: [{ name: "Finish", values: ["Matte White", "Speckled Clay"] }],
    variants: [
      { title: "Matte White",  price: "54.00", sku: "POS-MW", weight_g: 820 },
      { title: "Speckled Clay",price: "54.00", sku: "POS-SC", weight_g: 840 },
    ],
    inventory: [22, 18],
  },

  // ── 6. Stainless Water Bottle (outdoor, simple) ───────────────────────────
  {
    title: "Insulated Stainless Steel Water Bottle — 750 ml",
    slug: "insulated-stainless-steel-water-bottle-750ml",
    type: "simple",
    description:
      "Double-wall vacuum-insulated 18/8 stainless steel keeps drinks cold 24 h, hot 12 h. " +
      "Wide-mouth lid accepts ice cubes, fits most bike cages and car cup holders. " +
      "BPA-free, lifetime guarantee, powder-coat finish rated for 1000+ dishwasher cycles. " +
      "Capacity: 750 ml / 25 oz. Weight: 320 g empty. " +
      "Use-cases: hiking, cycling, gym, office, school. " +
      "Compatible accessories: straw lid, handle cap (sold separately).",
    vendor: "Crft Goods",
    tags: ["water-bottle", "stainless", "insulated", "outdoor", "hydration", "zero-waste"],
    options: [{ name: "Colour", values: ["Slate", "Alpine White", "Forest Green", "Midnight"] }],
    variants: [
      { title: "Slate",        price: "38.00", sku: "WB750-SL", weight_g: 320 },
      { title: "Alpine White", price: "38.00", sku: "WB750-AW", weight_g: 320 },
      { title: "Forest Green", price: "38.00", sku: "WB750-FG", weight_g: 320 },
      { title: "Midnight",     price: "38.00", sku: "WB750-MN", weight_g: 320 },
    ],
    inventory: [50, 42, 38, 45],
  },

  // ── 7. Notebook (stationery, simple) ─────────────────────────────────────
  {
    title: "Lay-Flat Dotted Notebook — A5",
    slug: "lay-flat-dotted-notebook-a5",
    type: "simple",
    description:
      "Thread-sewn binding opens 180° flat without cracking spine. " +
      "160 pages of 120 GSM Tomoe River paper (fountain-pen friendly, minimal bleed-through). " +
      "Dotted 5 mm grid. Hardcover cloth exterior with foil title stamp. " +
      "Use-cases: bullet journaling, sketching, meeting notes, design ideation. " +
      "Audience: designers, writers, students, remote workers. " +
      "Dimensions: A5 (148 × 210 mm). Ribbon bookmark included.",
    vendor: "Crft Goods",
    tags: ["notebook", "stationery", "journal", "A5", "dotted", "fountain-pen", "writing"],
    options: [{ name: "Colour", values: ["Charcoal", "Terracotta", "Sage"] }],
    variants: [
      { title: "Charcoal",   price: "22.00", sku: "NBK-A5-CH", weight_g: 280 },
      { title: "Terracotta", price: "22.00", sku: "NBK-A5-TC", weight_g: 280 },
      { title: "Sage",       price: "22.00", sku: "NBK-A5-SG", weight_g: 280 },
    ],
    inventory: [60, 45, 50],
  },

  // ── 8. Digital download (digital type, no shipping) ───────────────────────
  {
    title: "Brand Foundations Asset Pack — Digital Download",
    slug: "brand-foundations-asset-pack-digital",
    type: "digital",
    description:
      "220-file digital asset library for independent brands, freelancers, and small studios. " +
      "Includes: 80 vector logo templates (AI + SVG), 60 brand mockup scenes (PSD + Figma), " +
      "40 social media templates (1×1, 9×16, 16×9), 30 colour palette cards, 10 type specimen sheets. " +
      "Audience: brand designers, marketing teams, Etsy sellers, SaaS founders. " +
      "Software: Adobe Illustrator CC 2022+, Figma (free plan compatible), Canva Pro. " +
      "Delivered as an instant download ZIP after purchase. License: commercial use, 1 seat.",
    vendor: "Crft Goods",
    tags: ["digital", "design", "branding", "assets", "templates", "figma", "illustrator"],
    variants: [
      { title: "Standard License (1 seat)",       price: "49.00",  sku: "BFA-STD",  weight_g: 0, track_inventory: false },
      { title: "Team License (up to 5 seats)",    price: "119.00", sku: "BFA-TEAM", weight_g: 0, track_inventory: false },
    ],
    inventory: [],
  },

  // ── 9. Bundle product ─────────────────────────────────────────────────────
  {
    title: "The Creator Starter Kit — Bundle",
    slug: "creator-starter-kit-bundle",
    type: "bundle",
    description:
      "Everything you need to set up a productive creative workspace on day one. " +
      "Bundle includes: 1 × Lay-Flat Dotted Notebook (your choice of colour), " +
      "1 × Waxed Canvas Tote (Natural / Tan), 1 × Ceramic Pour-Over Set (Matte White). " +
      "Bundled price saves 18% vs buying items individually. " +
      "Perfect gift for: freelancers, designers, students, new hires, WFH workers.",
    vendor: "Crft Goods",
    tags: ["bundle", "gift", "starter-kit", "stationery", "coffee", "carry"],
    variants: [
      { title: "Default", price: "129.00", compare_at_price: "155.00", sku: "CSK-DEFAULT", weight_g: 1780 },
    ],
    inventory: [10],
  },

  // ── 10. Subscription product ──────────────────────────────────────────────
  {
    title: "Monthly Coffee Replenishment — Subscription",
    slug: "monthly-coffee-replenishment-subscription",
    type: "subscription",
    description:
      "Never run out of good coffee. Receive a freshly-roasted 250 g bag of single-origin filter coffee, " +
      "curated by our roaster partner, delivered monthly to your door. " +
      "Subscription features: skip any month, change origin preference, cancel anytime. " +
      "Origins rotate quarterly: Ethiopia (Yirgacheffe), Colombia (Huila), Kenya (AA). " +
      "Audience: pour-over enthusiasts, cold-brew makers, home baristas. " +
      "Roast level: light to medium. Grind: whole bean (request ground at checkout).",
    vendor: "Crft Goods",
    tags: ["coffee", "subscription", "replenishment", "monthly", "single-origin", "specialty"],
    variants: [
      { title: "250g — Monthly", price: "18.00", sku: "CFR-250-M", weight_g: 300, track_inventory: false },
      { title: "500g — Monthly", price: "32.00", sku: "CFR-500-M", weight_g: 550, track_inventory: false },
    ],
    inventory: [],
  },

  // ── 11. Wool Crew Socks (apparel accessory, simple) ───────────────────────
  {
    title: "Merino Hiking Crew Socks — 3-Pack",
    slug: "merino-hiking-crew-socks-3-pack",
    type: "simple",
    description:
      "Three-pair pack of cushioned merino hiking socks. " +
      "70% merino wool (18.5 micron), 25% nylon, 5% elastane. " +
      "Arch support band, terry-loop cushion sole, seamless toe. " +
      "Rated for day hikes and multi-day trekking when paired with hiking boots. " +
      "Machine wash cold. " +
      "Audience: hikers, trail runners, outdoor commuters.",
    vendor: "Crft Goods",
    tags: ["socks", "merino", "hiking", "apparel", "outdoor", "accessories"],
    options: [{ name: "Size", values: ["S/M (EU 36-40)", "L/XL (EU 41-46)"] }],
    variants: [
      { title: "S/M (EU 36-40)",  price: "24.00", sku: "MHS-SM",  weight_g: 120 },
      { title: "L/XL (EU 41-46)", price: "24.00", sku: "MHS-LXL", weight_g: 130 },
    ],
    inventory: [80, 70],
  },

  // ── 12. Reusable Beeswax Wraps (home/eco, simple) ────────────────────────
  {
    title: "Organic Beeswax Food Wraps — 3-Pack",
    slug: "organic-beeswax-food-wraps-3-pack",
    type: "simple",
    description:
      "Plastic-free alternative to cling wrap. " +
      "GOTS-certified organic cotton infused with sustainably harvested beeswax, " +
      "pine resin, and jojoba oil. " +
      "Pack includes: 1 × small (17 × 20 cm), 1 × medium (25 × 28 cm), 1 × large (33 × 35 cm). " +
      "Naturally antimicrobial. Mouldable with hand warmth. Cold-water washable, reusable 1 year+. " +
      "Audience: zero-waste households, eco-conscious cooks, sustainable gifting. " +
      "Not for: raw meat, microwave use.",
    vendor: "Crft Goods",
    tags: ["zero-waste", "beeswax", "eco", "kitchen", "sustainable", "plastic-free", "home"],
    options: [{ name: "Pattern", values: ["Botanical Print", "Stripe"] }],
    variants: [
      { title: "Botanical Print", price: "19.00", sku: "BWW-BP", weight_g: 90 },
      { title: "Stripe",          price: "19.00", sku: "BWW-ST", weight_g: 90 },
    ],
    inventory: [55, 48],
  },
];

// ── Main seedDemoStore function ────────────────────────────────────────────────

/**
 * Seed the demo store into the given pool.
 *
 * Idempotent: checks for existing store with slug "crft-goods" and returns
 * early (alreadyExisted = true) if found. Re-running with the same pool
 * is safe — it will not duplicate data.
 *
 * @param pool  pg.Pool with correct search_path already set (test-injected or dev)
 * @param print Whether to print the API keys to stdout (default true)
 */
export async function seedDemoStore(
  pool: pg.Pool,
  opts: { print?: boolean } = {}
): Promise<SeedResult> {
  const print = opts.print ?? true;
  const DEMO_ORG_ID = deterministicUuid("crft-goods-demo-org");
  const DEMO_STORE_SLUG = "crft-goods";

  // ── 1. Check idempotency ────────────────────────────────────────────────────
  // Check by slug alone (more robust across schema variants)
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM stores WHERE slug = $1 LIMIT 1`,
    [DEMO_STORE_SLUG]
  );

  if (existing.rows[0]) {
    const storeId = existing.rows[0].id;
    if (print) {
      console.log("\n[seed] Demo store already exists — skipping.");
      console.log(`  org_id:   ${DEMO_ORG_ID}`);
      console.log(`  store_id: ${storeId}`);
    }
    return {
      orgId: DEMO_ORG_ID,
      storeId,
      pubKey: "already-exists",
      prvKey: "already-exists",
      warehouseId: "",
      productIds: [],
      variantIds: [],
      collectionId: "",
      smartCollectionId: "",
      discountId: "",
      shippingZoneId: "",
      alreadyExisted: true,
    };
  }

  // ── 2. Create organization if the table exists ──────────────────────────────
  // In the dev DB (pre-existing schema) organizations has a FK; in fresh test
  // schemas the migration left organization_id as plain uuid with no FK.
  // We attempt an upsert into organizations; if the table doesn't exist we skip.
  try {
    await pool.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1::uuid, 'Crft Goods', 'crft-goods-demo')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
      [DEMO_ORG_ID]
    );
  } catch (err: unknown) {
    // 42P01 = relation does not exist (fresh test schema — no organizations table)
    if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "42P01")) {
      throw err;
    }
    // organizations table absent — OK, org_id is a plain uuid on stores
  }

  // ── 3. Create store ─────────────────────────────────────────────────────────
  const storeRes = await pool.query<{ id: string }>(
    `INSERT INTO stores (organization_id, name, slug, currency, timezone, is_active)
     VALUES ($1::uuid, 'Crft Goods', $2, 'USD', 'America/New_York', true)
     ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id::text`,
    [DEMO_ORG_ID, DEMO_STORE_SLUG]
  );
  const storeId = storeRes.rows[0]!.id;

  // ── 3. Issue API keys ───────────────────────────────────────────────────────
  const pubRaw = genKey("public");
  const prvRaw = genKey("private");

  await pool.query(
    `INSERT INTO api_keys
       (organization_id, store_id, name, key_hash, key_masked, scopes, is_active)
     VALUES
       ($1::uuid, $2::uuid, 'Demo Public Key',  $3, $4, ARRAY['commerce:read'], true),
       ($1::uuid, $2::uuid, 'Demo Private Key', $5, $6, ARRAY['commerce:read','commerce:write','commerce:admin'], true)`,
    [DEMO_ORG_ID, storeId, hashKey(pubRaw), maskKey(pubRaw), hashKey(prvRaw), maskKey(prvRaw)]
  );

  if (print) {
    const pad38 = (s: string) => s.padEnd(38);
    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║         Crft Goods Demo Store — API Keys             ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  STORE_ID:   ${pad38(storeId)} ║`);
    console.log(`║  cc_pub_:    ${pad38(pubRaw)} ║`);
    console.log(`║  cc_prv_:    ${pad38(prvRaw)} ║`);
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log("  Save these — they are printed once and not stored in plain text.\n");
  }

  // ── 4. Create default warehouse ─────────────────────────────────────────────
  const whRes = await pool.query<{ id: string }>(
    `INSERT INTO warehouses
       (store_id, name, code, is_active, is_default, fulfills_online)
     VALUES
       ($1::uuid, 'Crft Goods Fulfilment Centre', 'DEFAULT', true, true, true)
     RETURNING id::text`,
    [storeId]
  );
  const warehouseId = whRes.rows[0]!.id;

  // ── 5. Seed products ────────────────────────────────────────────────────────
  const productIds: string[] = [];
  const variantIds: string[][] = [];

  for (const pd of PRODUCTS) {
    // Create product
    const pRes = await pool.query<{ id: string }>(
      `INSERT INTO products
         (store_id, title, slug, description, type, status, vendor, tags,
          seo_title, seo_desc)
       VALUES
         ($1::uuid, $2, $3, $4, $5::text, 'active', $6, $7, $8, $9)
       ON CONFLICT (store_id, slug) DO UPDATE SET status = 'active'
       RETURNING id::text`,
      [
        storeId,
        pd.title,
        pd.slug,
        pd.description,
        pd.type,
        pd.vendor,
        pd.tags,
        pd.seo_title ?? pd.title,
        pd.seo_desc ?? pd.description.slice(0, 160),
      ]
    );
    const productId = pRes.rows[0]!.id;
    productIds.push(productId);

    // Create product options
    if (pd.options) {
      for (let oi = 0; oi < pd.options.length; oi++) {
        const opt = pd.options[oi]!;
        const optRes = await pool.query<{ id: string }>(
          `INSERT INTO product_options (product_id, name, position)
           VALUES ($1::uuid, $2, $3)
           RETURNING id::text`,
          [productId, opt.name, oi + 1]
        );
        const optionId = optRes.rows[0]!.id;
        for (let vi = 0; vi < opt.values.length; vi++) {
          await pool.query(
            `INSERT INTO product_option_values (option_id, value, position)
             VALUES ($1::uuid, $2, $3)`,
            [optionId, opt.values[vi], vi + 1]
          );
        }
      }
    }

    // Create variants
    const pvIds: string[] = [];
    for (let vi = 0; vi < pd.variants.length; vi++) {
      const vd = pd.variants[vi]!;
      const trackInventory = vd.track_inventory !== false;
      const varRes = await pool.query<{ id: string }>(
        `INSERT INTO product_variants
           (product_id, title, sku, price, compare_at_price, weight_g,
            position, track_inventory, requires_shipping, is_active)
         VALUES
           ($1::uuid, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9, true)
         RETURNING id::text`,
        [
          productId,
          vd.title,
          vd.sku ?? null,
          vd.price,
          vd.compare_at_price ?? null,
          vd.weight_g ?? 0,
          vi + 1,
          trackInventory,
          trackInventory,  // requires_shipping = same as track_inventory for these products
        ]
      );
      const variantId = varRes.rows[0]!.id;
      pvIds.push(variantId);

      // Set inventory level
      if (trackInventory && pd.inventory && pd.inventory[vi] !== undefined) {
        const qty = pd.inventory[vi]!;
        await pool.query(
          `INSERT INTO inventory_levels
             (variant_id, warehouse_id, quantity_on_hand)
           VALUES ($1::uuid, $2::uuid, $3)
           ON CONFLICT (variant_id, warehouse_id)
           DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand`,
          [variantId, warehouseId, qty]
        );
        // Best-effort audit row (no unique constraint — just insert)
        try {
          await pool.query(
            `INSERT INTO inventory_adjustments
               (variant_id, warehouse_id, quantity_delta, reason, reference_type)
             VALUES ($1::uuid, $2::uuid, $3, 'initial_count', 'seed')`,
            [variantId, warehouseId, qty]
          );
        } catch {
          // Ignore — audit log is best-effort
        }
      }
    }
    variantIds.push(pvIds);
  }

  // ── 6. Create manual collection ─────────────────────────────────────────────
  const colRes = await pool.query<{ id: string }>(
    `INSERT INTO collections
       (store_id, title, slug, description, is_active)
     VALUES
       ($1::uuid, 'New Arrivals', 'new-arrivals',
        'The latest additions to the Crft Goods catalogue.', true)
     ON CONFLICT (store_id, slug) DO UPDATE SET title = EXCLUDED.title
     RETURNING id::text`,
    [storeId]
  );
  const collectionId = colRes.rows[0]!.id;

  // Add first 6 products to the manual collection
  for (let i = 0; i < Math.min(6, productIds.length); i++) {
    await pool.query(
      `INSERT INTO product_collections (product_id, collection_id, position)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT DO NOTHING`,
      [productIds[i], collectionId, i + 1]
    );
  }

  // ── 7. Create smart collection ──────────────────────────────────────────────
  const smartColRes = await pool.query<{ id: string }>(
    `INSERT INTO collections
       (store_id, title, slug, description, is_active, is_smart, sort_order)
     VALUES
       ($1::uuid, 'All Active Products', 'all-active',
        'Automatically includes all active products in the store.',
        true, true, 'created_desc')
     ON CONFLICT (store_id, slug) DO UPDATE SET title = EXCLUDED.title
     RETURNING id::text`,
    [storeId]
  );
  const smartCollectionId = smartColRes.rows[0]!.id;

  await pool.query(
    `INSERT INTO collection_rules
       (collection_id, field, relation, value, position)
     VALUES ($1::uuid, 'status', 'equals', 'active', 1)`,
    [smartCollectionId]
  );

  // Populate smart collection
  await pool.query(
    `INSERT INTO product_collections (product_id, collection_id, position)
     SELECT p.id, $1::uuid,
            ROW_NUMBER() OVER (ORDER BY p.created_at DESC)::int
     FROM products p
     WHERE p.store_id = $2::uuid AND p.status = 'active'
     ON CONFLICT DO NOTHING`,
    [smartCollectionId, storeId]
  );

  // ── 8. Create discount code WELCOME10 ──────────────────────────────────────
  const discRes = await pool.query<{ id: string }>(
    `INSERT INTO discount_codes
       (store_id, code, type, value, min_order_total, once_per_customer,
        applies_to, is_active, metadata)
     VALUES
       ($1::uuid, 'WELCOME10', 'percentage', 10, 0, false, 'order', true, '{}')
     ON CONFLICT (store_id, code) DO UPDATE SET is_active = true
     RETURNING id::text`,
    [storeId]
  );
  const discountId = discRes.rows[0]!.id;

  // ── 9. Create shipping zone ──────────────────────────────────────────────────
  // shipping_zones has no unique constraint — just insert
  const szRes = await pool.query<{ id: string }>(
    `INSERT INTO shipping_zones (store_id, name)
     VALUES ($1::uuid, 'Worldwide')
     RETURNING id::text`,
    [storeId]
  );
  const shippingZoneId = szRes.rows[0]!.id;

  // US zone_region row (char(2) country_code required)
  const szrRes = await pool.query<{ id: string }>(
    `INSERT INTO shipping_zone_regions (zone_id, country_code)
     VALUES ($1::uuid, 'US')
     RETURNING id::text`,
    [shippingZoneId]
  );
  const regionId = szrRes.rows[0]!.id;
  void regionId; // used below for shipping_rates which need zone_id

  // Flat rate $7.99 (all orders) — zone_id not region_id per schema
  await pool.query(
    `INSERT INTO shipping_rates (zone_id, name, price, is_active)
     VALUES ($1::uuid, 'Standard Shipping', 7.99, true)`,
    [shippingZoneId]
  );
  // Free shipping over $100
  await pool.query(
    `INSERT INTO shipping_rates (zone_id, name, price, min_order_total, is_active)
     VALUES ($1::uuid, 'Free Shipping (orders over $100)', 0, 100, true)`,
    [shippingZoneId]
  );

  // Also add a worldwide catch-all region for non-US
  await pool.query(
    `INSERT INTO shipping_zone_regions (zone_id, country_code)
     VALUES ($1::uuid, 'ZZ')`,  // ZZ = unspecified/rest of world
    [shippingZoneId]
  ).catch(() => {
    // char(2) may reject ZZ — use GB as global placeholder
    return pool.query(
      `INSERT INTO shipping_zone_regions (zone_id, country_code)
       VALUES ($1::uuid, 'GB')`,
      [shippingZoneId]
    ).catch(() => { /* ignore */ });
  });

  // ── 10. Create tax zone ──────────────────────────────────────────────────────
  const tzRes = await pool.query<{ id: string }>(
    `INSERT INTO tax_zones (store_id, name)
     VALUES ($1::uuid, 'United States')
     RETURNING id::text`,
    [storeId]
  );
  const taxZoneId = tzRes.rows[0]!.id;

  await pool.query(
    `INSERT INTO tax_zone_regions (zone_id, country_code)
     VALUES ($1::uuid, 'US')`,
    [taxZoneId]
  );
  await pool.query(
    `INSERT INTO tax_rates (zone_id, name, rate_pct, is_inclusive, is_active)
     VALUES ($1::uuid, 'US Default Tax (0%)', 0, false, true)`,
    [taxZoneId]
  );

  if (print) {
    console.log(`[seed] Done! Crft Goods demo store seeded.`);
    console.log(`  ${productIds.length} products (12 total, various types)`);
    console.log(`  2 collections: "New Arrivals" (manual) + "All Active Products" (smart)`);
    console.log(`  Discount: WELCOME10 (10% off, no minimum)`);
    console.log(`  Shipping: Worldwide flat $7.99, free over $100`);
    console.log(`  Warehouse: Crft Goods Fulfilment Centre`);
    console.log(`\n  Add to your MCP client config:`);
    console.log(`    CARTCRFT_STORE_ID=${storeId}`);
    console.log(`    CARTCRFT_API_KEY=${pubRaw}   # read-only (browse + search)`);
    console.log(`    # For checkout flows use the private key:`);
    console.log(`    CARTCRFT_API_KEY=${prvRaw}   # read+write\n`);
  }

  return {
    orgId: DEMO_ORG_ID,
    storeId,
    pubKey: pubRaw,
    prvKey: prvRaw,
    warehouseId,
    productIds,
    variantIds,
    collectionId,
    smartCollectionId,
    discountId,
    shippingZoneId,
    alreadyExisted: false,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

async function main() {
  const { config: dotenvConfig } = await import("dotenv");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Traverse: src/seed/ → src/ → backend/ → repo root
  dotenvConfig({ path: path.resolve(__dirname, "../../../.env"), override: false });

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("[seed] ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  try {
    await seedDemoStore(pool, { print: true });
  } catch (err) {
    console.error("[seed] ERROR:", err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// ESM: run when executed directly
const scriptPath = process.argv[1] ?? "";
if (scriptPath.includes("seed") || scriptPath.includes("main")) {
  void main();
}
