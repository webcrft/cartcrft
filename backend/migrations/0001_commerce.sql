-- ============================================================================
-- 0001_COMMERCE — core ecommerce schema
--
-- Ported from webcrft-mono: 20260407000033_commerce.sql
-- Cartcrft adaptations:
--   • organization_id is plain uuid (no FK — no platform org table in this repo)
--   • products.created_by / order_events.created_by / etc. reference removed
--     (no platform profiles table); column kept as uuid nullable with no FK
--   • profiles FK on discount_codes.created_by, inventory_adjustments.created_by,
--     automatic_discounts.created_by, quotes.created_by → plain uuid nullable
--   • stores.organization_id: plain uuid not null (no FK)
--   • CREATE EXTENSION vector guarded by DO-block (warn but don't fail)
--   • products.embedding vector(1536) nullable + products.embedding_updated_at
--   • idempotency_key text columns + partial unique indexes on carts, checkouts, orders
--   • All wc_ / webcrft branding replaced with cc_ / cartcrft
--   • No site_id FK, no builder/renderer/sites/chat/forms references
--   • set_updated_at() trigger function defined here (no dependency on platform core)
--
-- Monetary values: numeric(15,2). Weights: bigint grams. Dims: bigint mm.
-- ============================================================================

begin;

-- ============================================================================
-- PREREQUISITES
-- ============================================================================

-- Shared updated_at trigger function (replaces platform dependency)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
comment on function public.set_updated_at() is
  'Sets updated_at = now() on every UPDATE. Attach as a BEFORE UPDATE trigger.';

-- pgvector: load if available; warn and continue if not.
do $$
begin
  create extension if not exists vector;
exception when others then
  raise warning 'pgvector extension not available (%). Semantic search will be disabled until pgvector is installed.', sqlerrm;
end
$$;

-- Auth user helper (RLS support — reads app.user_id GUC set by the server)
create or replace function public.auth_user_id()
returns uuid
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v text;
begin
  v := nullif(current_setting('app.user_id', true), '');
  if v is null then
    return null;
  end if;
  return v::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;
comment on function public.auth_user_id() is
  'Returns the UUID of the current app user from app.user_id GUC. Used in RLS policies.';

-- ============================================================================
-- 1. STORES
-- ============================================================================

create table public.stores (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,   -- plain uuid; no FK (no platform org table)
  name              text        not null,
  slug              text        not null,
  currency          char(3)     not null default 'USD',   -- ISO 4217
  weight_unit       text        not null default 'g'
                      check (weight_unit in ('g','kg','lb','oz')),
  timezone          text        not null default 'UTC',
  country_code      char(2),                              -- ISO 3166-1 alpha-2
  email             text,
  phone             text,
  address           jsonb,
  enable_currency_conversion boolean not null default false,
  -- i18n / storefront domain
  domain            text,
  supported_locales text[]      not null default '{}',
  default_locale    text        not null default 'en',
  -- sequences (atomically incremented)
  order_sequence    bigint      not null default 0,
  booking_sequence  bigint      not null default 0,
  -- super-admin takedown
  taken_down_at     timestamptz,
  taken_down_reason text,
  metadata          jsonb       not null default '{}',
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(organization_id, slug)
);

comment on table  public.stores                    is 'A store belongs to an organization. One org can operate multiple independent stores with separate catalogs, currencies, and settings.';
comment on column public.stores.organization_id    is 'Owning organization UUID. Plain reference — no FK to a platform org table.';
comment on column public.stores.domain             is 'Public storefront domain used to generate product feed link URLs (Google Shopping, Facebook Catalog).';
comment on column public.stores.supported_locales  is 'BCP-47 locale codes this store serves content in, e.g. {en, fr, ar, zh-CN}.';
comment on column public.stores.default_locale     is 'Fallback locale when no translation exists for the requested locale.';
comment on column public.stores.order_sequence     is 'Per-store atomic counter for order numbers. Incremented by next_order_number().';
comment on column public.stores.booking_sequence   is 'Per-store atomic counter for booking numbers. Incremented by next_booking_number().';

create index idx_stores_org         on public.stores(organization_id);
create index idx_stores_org_created on public.stores(organization_id, created_at desc);

-- ============================================================================
-- 2. PLUGGABLE PROVIDERS
-- ============================================================================

create table public.payment_providers (
  id             uuid        primary key default gen_random_uuid(),
  store_id       uuid        not null references public.stores(id) on delete cascade,
  name           text        not null,
  type           text        not null check (type in ('webhook','stripe','paystack','razorpay','xendit')),
  webhook_url    text,
  webhook_secret text,   -- AES-256-GCM ciphertext (base64) when AUTH_SECRETS_KEY set, else plaintext (dev)
  slug           text,   -- built-in provider identifier: 'paystack', 'stripe'. NULL for custom providers.
  config         jsonb   not null default '{}',
  is_active      boolean not null default true,
  position       int     not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table  public.payment_providers                is 'Registered payment providers per store.';
comment on column public.payment_providers.webhook_secret is
  'AES-256-GCM ciphertext (base64) of the provider webhook shared secret when '
  'AUTH_SECRETS_KEY is set, or plaintext in dev. Decoded before HMAC verification.';
create index idx_payment_providers_store on public.payment_providers(store_id);
create unique index idx_payment_providers_slug on public.payment_providers(store_id, slug) where slug is not null;

create table public.shipping_providers (
  id             uuid    primary key default gen_random_uuid(),
  store_id       uuid    not null references public.stores(id) on delete cascade,
  name           text    not null,
  type           text    not null check (type in ('webhook','flat_rate','free','local_pickup')),
  webhook_url    text,
  webhook_secret text,   -- AES-256-GCM ciphertext (base64) when AUTH_SECRETS_KEY set
  config         jsonb   not null default '{}',
  is_active      boolean not null default true,
  position       int     not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.shipping_providers is 'Registered shipping/carrier providers. Webhook type enables real-time rate fetching (Bobgo, etc).';
comment on column public.shipping_providers.webhook_secret is
  'AES-256-GCM ciphertext (base64) of the provider webhook shared secret when '
  'AUTH_SECRETS_KEY is set, or plaintext in dev.';
create index idx_shipping_providers_store on public.shipping_providers(store_id);

create table public.tax_providers (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id) on delete cascade,
  name        text    not null,
  type        text    not null check (type in ('webhook','manual')),
  webhook_url text,
  config      jsonb   not null default '{}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.tax_providers is 'Pluggable tax calculation. manual = use tax_rates table. webhook = call external engine (Avalara, TaxJar, etc).';
create index idx_tax_providers_store on public.tax_providers(store_id);

create table public.notification_providers (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id) on delete cascade,
  name        text    not null,
  type        text    not null check (type in ('webhook','email','sms','whatsapp')),
  webhook_url text,
  config      jsonb   not null default '{}',
  events      text[]  not null default '{}'
                check (events <@ ARRAY[
                  'order.created','order.updated','order.cancelled',
                  'payment.captured','payment.refunded',
                  'shipment.created','shipment.updated','shipment.delivered','shipment.tracking_updated',
                  'customer.created','inventory.low',
                  'quote.sent','quote.converted','subscription.disable'
                ]::text[]),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.notification_providers is 'Notification channels per store. events array controls which events fire this provider.';
create index idx_notification_providers_store on public.notification_providers(store_id);

-- ============================================================================
-- 3. TAX CATEGORIES
-- ============================================================================

create table public.tax_categories (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null,
  code       text not null,   -- e.g. 'standard', 'zero_rated', 'exempt', 'reduced'
  created_at timestamptz not null default now(),
  unique(store_id, code)
);
comment on table public.tax_categories is 'Product tax categories. Variants reference a category; rates applied per zone×category.';
create index idx_tax_categories_store on public.tax_categories(store_id);

-- ============================================================================
-- 4. CATALOG
-- ============================================================================

create table public.products (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id) on delete cascade,
  title       text    not null,
  slug        text    not null,
  description text,
  type        text    not null default 'simple'
                check (type in (
                  'simple','bundle','configurable','digital',
                  'service','subscription','rental'
                )),
  status      text    not null default 'draft'
                check (status in ('draft','active','archived')),
  vendor      text,
  tags        text[]  not null default '{}',
  seo_title   text,
  seo_desc    text,
  -- pgvector semantic search (nullable; populated by embedding worker)
  embedding             vector(1536),
  embedding_updated_at  timestamptz,
  metadata    jsonb   not null default '{}',
  created_by  uuid,   -- nullable, no FK (no platform profiles table)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(store_id, slug),
  check (octet_length(description) <= 65536),
  check (octet_length(metadata::text) <= 65536)
);
comment on table  public.products            is 'Base product record. Type determines variant/inventory behaviour. No variant count limit (unlike Shopify 100-variant cap).';
comment on column public.products.embedding  is 'pgvector(1536) embedding for semantic catalog search. NULL until indexed by the embedding worker. Requires pgvector extension.';
create index idx_products_store        on public.products(store_id);
create index idx_products_status       on public.products(store_id, status);
create index idx_products_tags         on public.products using gin(tags);
create index idx_products_store_created on public.products(store_id, created_at desc);

-- Option types (Size, Colour, Material) — unlimited
create table public.product_options (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name       text not null,
  position   int  not null default 0
);
comment on table public.product_options is 'Option type dimensions for a product. No 3-option limit.';
create index idx_product_options_product on public.product_options(product_id);

-- Option values (XS, S, M, L; Red, Blue)
create table public.product_option_values (
  id        uuid primary key default gen_random_uuid(),
  option_id uuid not null references public.product_options(id) on delete cascade,
  value     text not null,
  position  int  not null default 0
);
create index idx_option_values_option on public.product_option_values(option_id);

-- Variants — purchasable SKUs
create table public.product_variants (
  id               uuid    primary key default gen_random_uuid(),
  product_id       uuid    not null references public.products(id) on delete cascade,
  sku              text,
  barcode          text,
  title            text,   -- auto-generated from option values if null
  price            numeric(15,2) not null,
  compare_at_price numeric(15,2),
  cost_price       numeric(15,2),
  weight_g         bigint  not null default 0,
  length_mm        bigint,
  width_mm         bigint,
  height_mm        bigint,
  requires_shipping boolean not null default true,
  is_taxable       boolean not null default true,
  tax_category_id  uuid    references public.tax_categories(id) on delete set null,
  track_inventory  boolean not null default true,
  allow_backorder  boolean not null default false,
  digital_url      text,
  position         int     not null default 0,
  is_active        boolean not null default true,
  metadata         jsonb   not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (octet_length(metadata::text) <= 16384)
);
comment on table public.product_variants is 'Purchasable SKU. No 100-variant limit. cost_price enables margin reporting.';
create index idx_variants_product on public.product_variants(product_id);
create index idx_variants_sku     on public.product_variants(sku)     where sku     is not null;
create index idx_variants_barcode on public.product_variants(barcode) where barcode is not null;

-- Junction: variant ↔ option values
create table public.variant_option_values (
  variant_id      uuid not null references public.product_variants(id)      on delete cascade,
  option_value_id uuid not null references public.product_option_values(id) on delete cascade,
  primary key (variant_id, option_value_id)
);

-- Media
create table public.product_media (
  id         uuid    primary key default gen_random_uuid(),
  product_id uuid    not null references public.products(id) on delete cascade,
  variant_id uuid    references public.product_variants(id) on delete set null,
  url        text    not null,
  cdn_url    text,
  type       text    not null default 'image' check (type in ('image','video','model_3d')),
  alt_text   text,
  position   int     not null default 0,
  created_at timestamptz not null default now()
);
create index idx_product_media_product on public.product_media(product_id);
create index idx_product_media_variant on public.product_media(variant_id) where variant_id is not null;

-- Bundles
create table public.product_bundle_items (
  id          uuid    primary key default gen_random_uuid(),
  product_id  uuid    not null references public.products(id)          on delete cascade,
  variant_id  uuid    not null references public.product_variants(id)  on delete restrict,
  quantity    int     not null default 1 check (quantity > 0),
  is_optional boolean not null default false,
  position    int     not null default 0
);
comment on table public.product_bundle_items is 'Components of a bundle/kit product. is_optional allows configurable bundle add-ons.';
create index idx_bundle_items_product on public.product_bundle_items(product_id);

-- Collections
create table public.collections (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id) on delete cascade,
  title       text    not null,
  slug        text    not null,
  description text,
  parent_id   uuid    references public.collections(id) on delete set null,
  image_url   text,
  seo_title   text,
  seo_desc    text,
  sort_order  text    not null default 'manual'
                check (sort_order in ('manual','price_asc','price_desc','title_asc','created_desc')),
  is_smart    boolean not null default false,
  smart_match text    not null default 'all'
                check (smart_match in ('all','any')),
  is_active   boolean not null default true,
  metadata    jsonb   not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(store_id, slug)
);
create index idx_collections_store  on public.collections(store_id);
create index idx_collections_parent on public.collections(parent_id) where parent_id is not null;

create table public.product_collections (
  product_id    uuid not null references public.products(id)    on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  position      int  not null default 0,
  primary key (product_id, collection_id)
);
create index idx_product_collections_collection on public.product_collections(collection_id);

-- ============================================================================
-- 5. PRICE LISTS
-- ============================================================================

create table public.price_lists (
  id         uuid    primary key default gen_random_uuid(),
  store_id   uuid    not null references public.stores(id) on delete cascade,
  name       text    not null,
  currency   char(3) not null,
  type       text    not null default 'retail'
               check (type in ('retail','wholesale','vip','staff','custom')),
  is_default boolean not null default false,
  metadata   jsonb   not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.price_lists is 'Named price lists for B2B, wholesale, VIP, and multi-currency.';
create index idx_price_lists_store on public.price_lists(store_id);

create table public.price_list_items (
  id            uuid    primary key default gen_random_uuid(),
  price_list_id uuid    not null references public.price_lists(id)        on delete cascade,
  variant_id    uuid    not null references public.product_variants(id)   on delete cascade,
  price         numeric(15,2) not null,
  min_qty       int     not null default 1,
  max_qty       int,
  created_at    timestamptz not null default now(),
  unique(price_list_id, variant_id, min_qty)
);
create index idx_price_list_items_list    on public.price_list_items(price_list_id);
create index idx_price_list_items_variant on public.price_list_items(variant_id);

-- ============================================================================
-- 6. INVENTORY
-- ============================================================================

create table public.warehouses (
  id              uuid    primary key default gen_random_uuid(),
  store_id        uuid    not null references public.stores(id) on delete cascade,
  name            text    not null,
  code            text,
  address         jsonb,
  is_active       boolean not null default true,
  is_default      boolean not null default false,
  fulfills_online boolean not null default true,
  metadata        jsonb   not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.warehouses is 'Stock locations: physical warehouses, 3PLs, retail stores used as fulfilment hubs.';
create index idx_warehouses_store on public.warehouses(store_id);

create table public.inventory_levels (
  id                 uuid primary key default gen_random_uuid(),
  variant_id         uuid not null references public.product_variants(id) on delete cascade,
  warehouse_id       uuid not null references public.warehouses(id)       on delete cascade,
  quantity_on_hand   int  not null default 0,
  quantity_committed int  not null default 0,
  quantity_incoming  int  not null default 0,
  reorder_point      int,
  reorder_qty        int,
  updated_at         timestamptz not null default now(),
  unique(variant_id, warehouse_id)
);
comment on table public.inventory_levels is 'Stock position per variant per warehouse. available = on_hand - committed.';
create index idx_inv_levels_variant   on public.inventory_levels(variant_id);
create index idx_inv_levels_warehouse on public.inventory_levels(warehouse_id);

create table public.inventory_lots (
  id           uuid    primary key default gen_random_uuid(),
  variant_id   uuid    not null references public.product_variants(id) on delete cascade,
  warehouse_id uuid    not null references public.warehouses(id)       on delete cascade,
  lot_number   text    not null,
  expiry_date  date,
  quantity     int     not null default 0 check (quantity >= 0),
  cost_price   numeric(15,2),
  received_at  timestamptz,
  metadata     jsonb   not null default '{}',
  created_at   timestamptz not null default now()
);
comment on table public.inventory_lots is 'Batch/lot tracking for FEFO picking (food, pharma, cosmetics).';
create index idx_inv_lots_variant on public.inventory_lots(variant_id);
create index idx_inv_lots_expiry  on public.inventory_lots(expiry_date) where expiry_date is not null;

create table public.inventory_adjustments (
  id             uuid primary key default gen_random_uuid(),
  variant_id     uuid not null references public.product_variants(id) on delete cascade,
  warehouse_id   uuid not null references public.warehouses(id)       on delete cascade,
  lot_id         uuid references public.inventory_lots(id) on delete set null,
  quantity_delta int  not null,
  reason         text not null
                   check (reason in (
                     'received','sold','returned','damaged','theft',
                     'correction','transfer_in','transfer_out','initial_count'
                   )),
  reference_type text,   -- 'order' | 'purchase_order' | 'return' | 'count'
  reference_id   uuid,
  notes          text,
  created_by     uuid,   -- nullable, no FK
  created_at     timestamptz not null default now()
);
comment on table public.inventory_adjustments is 'Append-only audit log of all stock movements.';
create index idx_inv_adj_variant   on public.inventory_adjustments(variant_id);
create index idx_inv_adj_warehouse on public.inventory_adjustments(warehouse_id);
create index idx_inv_adj_ref       on public.inventory_adjustments(reference_type, reference_id)
  where reference_id is not null;

-- ============================================================================
-- 7. CUSTOMERS & B2B
-- ============================================================================

create table public.customers (
  id                uuid    primary key default gen_random_uuid(),
  store_id          uuid    not null references public.stores(id) on delete cascade,
  email             text    not null,
  first_name        text,
  last_name         text,
  phone             text,
  accepts_marketing boolean not null default false,
  price_list_id     uuid    references public.price_lists(id) on delete set null,
  tax_exempt        boolean not null default false,
  tax_exempt_code   text,
  notes             text,
  tags              text[]  not null default '{}',
  metadata          jsonb   not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(store_id, email),
  check (octet_length(notes) <= 16384)
);
comment on table public.customers is 'Store customer record. price_list_id overrides default retail pricing.';
create index idx_customers_store        on public.customers(store_id);
create index idx_customers_email        on public.customers(store_id, email);
create index idx_customers_store_created on public.customers(store_id, created_at desc);

create table public.customer_addresses (
  id                  uuid    primary key default gen_random_uuid(),
  customer_id         uuid    not null references public.customers(id) on delete cascade,
  first_name          text,
  last_name           text,
  company             text,
  line1               text    not null,
  line2               text,
  city                text    not null,
  province            text,
  province_code       text,
  postal_code         text,
  country_code        char(2) not null,
  phone               text,
  is_default_shipping boolean not null default false,
  is_default_billing  boolean not null default false,
  created_at          timestamptz not null default now()
);
create index idx_customer_addresses_customer on public.customer_addresses(customer_id);

-- Suppliers (referenced by order_lines.supplier_id)
create table public.suppliers (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id) on delete cascade,
  name        text    not null,
  email       text,
  phone       text,
  address     jsonb,
  currency    char(3),
  notes       text,
  metadata    jsonb   not null default '{}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_suppliers_store on public.suppliers(store_id);

-- B2B companies
create table public.companies (
  id                 uuid    primary key default gen_random_uuid(),
  store_id           uuid    not null references public.stores(id) on delete cascade,
  name               text    not null,
  tax_number         text,
  credit_limit       numeric(15,2),
  credit_used        numeric(15,2) not null default 0,
  payment_terms_days int     not null default 0,
  price_list_id      uuid    references public.price_lists(id) on delete set null,
  billing_address    jsonb,
  notes              text,
  metadata           jsonb   not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.companies is 'B2B company accounts. credit_limit/payment_terms_days enable net-terms invoicing (net-30/60/90).';
create index idx_companies_store on public.companies(store_id);

create table public.company_customers (
  company_id  uuid not null references public.companies(id)  on delete cascade,
  customer_id uuid not null references public.customers(id)  on delete cascade,
  role        text not null default 'buyer' check (role in ('owner','buyer','viewer')),
  created_at  timestamptz not null default now(),
  primary key (company_id, customer_id)
);

create table public.customer_groups (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  name          text not null,
  description   text,
  price_list_id uuid references public.price_lists(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index idx_customer_groups_store on public.customer_groups(store_id);

create table public.customer_group_members (
  group_id    uuid not null references public.customer_groups(id) on delete cascade,
  customer_id uuid not null references public.customers(id)       on delete cascade,
  primary key (group_id, customer_id)
);

-- ============================================================================
-- 8. TAX (manual rates)
-- ============================================================================

create table public.tax_zones (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index idx_tax_zones_store on public.tax_zones(store_id);

create table public.tax_zone_regions (
  id            uuid    primary key default gen_random_uuid(),
  zone_id       uuid    not null references public.tax_zones(id) on delete cascade,
  country_code  char(2) not null,
  province_code text
);
create index idx_tax_zone_regions_zone    on public.tax_zone_regions(zone_id);
create index idx_tax_zone_regions_country on public.tax_zone_regions(country_code);

create table public.tax_rates (
  id           uuid    primary key default gen_random_uuid(),
  zone_id      uuid    not null references public.tax_zones(id)    on delete cascade,
  category_id  uuid    references public.tax_categories(id)        on delete cascade,
  name         text    not null,
  rate_pct     numeric(7,4) not null,
  is_inclusive boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
comment on table public.tax_rates is 'Manual tax rates per zone×category. is_inclusive = tax already in price.';
create index idx_tax_rates_zone on public.tax_rates(zone_id);

-- ============================================================================
-- 9. SHIPPING ZONES & STATIC RATES
-- ============================================================================

create table public.shipping_zones (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index idx_shipping_zones_store on public.shipping_zones(store_id);

create table public.shipping_zone_regions (
  id            uuid    primary key default gen_random_uuid(),
  zone_id       uuid    not null references public.shipping_zones(id) on delete cascade,
  country_code  char(2) not null,
  province_code text
);
create index idx_shipping_zone_regions_zone on public.shipping_zone_regions(zone_id);

create table public.shipping_rates (
  id                 uuid    primary key default gen_random_uuid(),
  zone_id            uuid    not null references public.shipping_zones(id)    on delete cascade,
  provider_id        uuid    references public.shipping_providers(id)         on delete set null,
  name               text    not null,
  price              numeric(15,2) not null default 0,
  min_weight_g       bigint,
  max_weight_g       bigint,
  min_order_total    numeric(15,2),
  max_order_total    numeric(15,2),
  estimated_days_min int,
  estimated_days_max int,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);
comment on table public.shipping_rates is 'Static flat/conditional rates per zone.';
create index idx_shipping_rates_zone on public.shipping_rates(zone_id);

create table public.collection_points (
  id              uuid    primary key default gen_random_uuid(),
  store_id        uuid    not null references public.stores(id) on delete cascade,
  provider_id     uuid    references public.shipping_providers(id) on delete set null,
  name            text    not null,
  provider_ref    text,
  address         jsonb   not null,
  coordinates     jsonb,
  operating_hours jsonb,
  is_active       boolean not null default true,
  metadata        jsonb   not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.collection_points is 'PUDO / locker / pickup point locations.';
create index idx_collection_points_store    on public.collection_points(store_id);
create index idx_collection_points_provider on public.collection_points(provider_id) where provider_id is not null;

-- ============================================================================
-- 10. DISCOUNTS & PROMOTIONS
-- ============================================================================

create table public.discount_codes (
  id                uuid    primary key default gen_random_uuid(),
  store_id          uuid    not null references public.stores(id) on delete cascade,
  code              text    not null,
  type              text    not null
                      check (type in (
                        'percentage','fixed_amount','free_shipping',
                        'bogo','buy_x_get_y'
                      )),
  value             numeric(15,4),
  min_order_total   numeric(15,2),
  min_qty           int,
  max_discount      numeric(15,2),
  max_uses          int,
  uses_count        int     not null default 0,
  once_per_customer boolean not null default false,
  applies_to        text    not null default 'order'
                      check (applies_to in (
                        'order','specific_products','specific_collections',
                        'specific_customers','customer_group'
                      )),
  applies_to_ids    uuid[]  not null default '{}',
  metadata          jsonb   not null default '{}',
  starts_at         timestamptz,
  ends_at           timestamptz,
  is_active         boolean not null default true,
  created_by        uuid,   -- nullable, no FK
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(store_id, code)
);
comment on table public.discount_codes is 'Discount codes and promotions. BOGO and buy_x_get_y rules stored in metadata.';
create index idx_discount_codes_store  on public.discount_codes(store_id);
create index idx_discount_codes_active on public.discount_codes(store_id, is_active, starts_at, ends_at);

-- ============================================================================
-- 11. CARTS & CHECKOUTS
-- ============================================================================

create table public.carts (
  id              uuid    primary key default gen_random_uuid(),
  store_id        uuid    not null references public.stores(id) on delete cascade,
  customer_id     uuid    references public.customers(id) on delete set null,
  currency        char(3) not null,
  status          text    not null default 'active'
                    check (status in ('active','converted','abandoned','expired')),
  idempotency_key text,   -- storefront/agent idempotency
  metadata        jsonb   not null default '{}',
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_carts_store    on public.carts(store_id, status);
create index idx_carts_customer on public.carts(customer_id) where customer_id is not null;
-- Idempotency: agent/storefront cart creation is idempotent per key
create unique index if not exists ux_carts_idempotency_key
  on public.carts(idempotency_key)
  where idempotency_key is not null;

create table public.cart_lines (
  id         uuid primary key default gen_random_uuid(),
  cart_id    uuid not null references public.carts(id)             on delete cascade,
  variant_id uuid not null references public.product_variants(id)  on delete restrict,
  quantity   int  not null check (quantity > 0),
  price      numeric(15,2) not null,
  metadata   jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_cart_lines_cart on public.cart_lines(cart_id);

create table public.checkouts (
  id                  uuid    primary key default gen_random_uuid(),
  cart_id             uuid    references public.carts(id) on delete set null,
  store_id            uuid    not null references public.stores(id) on delete cascade,
  customer_id         uuid    references public.customers(id) on delete set null,
  company_id          uuid    references public.companies(id) on delete set null,
  email               text,
  shipping_address    jsonb,
  billing_address     jsonb,
  collection_point_id uuid    references public.collection_points(id) on delete set null,
  shipping_rate       jsonb,   -- { name, price, provider_id, carrier, service_level, eta }
  tax_lines           jsonb,   -- [{ name, rate_pct, amount, is_inclusive }]
  discount_lines      jsonb,   -- [{ code, type, amount }]
  subtotal            numeric(15,2) not null default 0,
  shipping_total      numeric(15,2) not null default 0,
  tax_total           numeric(15,2) not null default 0,
  discount_total      numeric(15,2) not null default 0,
  total               numeric(15,2) not null default 0,
  currency            char(3) not null,
  payment_session     jsonb,
  status              text    not null default 'pending'
                        check (status in ('pending','completed','abandoned')),
  idempotency_key     text,   -- passed through to complete operation
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.checkouts is 'In-progress checkout snapshot. Converted to an order on payment capture.';
create index idx_checkouts_store    on public.checkouts(store_id, status);
create index idx_checkouts_customer on public.checkouts(customer_id) where customer_id is not null;
-- Idempotency: complete operation is idempotent per key per store
create unique index if not exists ux_checkouts_idempotency_key
  on public.checkouts(store_id, idempotency_key)
  where idempotency_key is not null;

-- ============================================================================
-- 12. ORDERS
-- ============================================================================

create table public.orders (
  id                  uuid    primary key default gen_random_uuid(),
  store_id            uuid    not null references public.stores(id) on delete cascade,
  customer_id         uuid    references public.customers(id)   on delete set null,
  company_id          uuid    references public.companies(id)   on delete set null,
  checkout_id         uuid    references public.checkouts(id)   on delete set null,
  order_number        text    not null,
  status              text    not null default 'open'
                        check (status in ('open','closed','cancelled')),
  financial_status    text    not null default 'pending'
                        check (financial_status in (
                          'pending','authorized','partially_paid','paid',
                          'partially_refunded','refunded','voided'
                        )),
  fulfillment_status  text    not null default 'unfulfilled'
                        check (fulfillment_status in (
                          'unfulfilled','partial','fulfilled','returned','restocked'
                        )),
  currency            char(3) not null,
  subtotal            numeric(15,2) not null,
  shipping_total      numeric(15,2) not null default 0,
  tax_total           numeric(15,2) not null default 0,
  discount_total      numeric(15,2) not null default 0,
  total               numeric(15,2) not null,
  total_refunded      numeric(15,2) not null default 0,
  shipping_address    jsonb   not null default '{}',
  billing_address     jsonb   not null default '{}',
  collection_point_id uuid    references public.collection_points(id) on delete set null,
  -- B2B
  po_number           text,
  payment_terms_days  int     not null default 0,
  due_date            date,
  -- Attribution
  source_name         text,
  referring_site      text,
  landing_site        text,
  ip_address          text,
  user_agent          text,
  -- Misc
  notes               text,
  tags                text[]  not null default '{}',
  tax_lines           jsonb,
  shipping_lines      jsonb,
  discount_lines      jsonb,
  metadata            jsonb   not null default '{}',
  cancelled_at        timestamptz,
  cancel_reason       text,
  booking_id          uuid,   -- FK to bookings table (added in 0007_booking.sql)
  is_test             boolean not null default false,
  idempotency_key     text,   -- idempotent order creation key
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique(store_id, order_number),
  check (octet_length(notes) <= 16384),
  check (octet_length(metadata::text) <= 65536)
);
comment on table public.orders is 'Core order. financial_status and fulfillment_status are independent state machines.';
create index idx_orders_store              on public.orders(store_id, created_at desc);
create index idx_orders_customer           on public.orders(customer_id)       where customer_id is not null;
create index idx_orders_financial_status   on public.orders(store_id, financial_status);
create index idx_orders_fulfillment_status on public.orders(store_id, fulfillment_status);
create index idx_orders_due_date           on public.orders(due_date)           where due_date    is not null;
-- Idempotent order creation (prevents double-order on checkout complete retry)
create unique index if not exists ux_orders_idempotency_key
  on public.orders(store_id, idempotency_key)
  where idempotency_key is not null;

create table public.order_lines (
  id                      uuid    primary key default gen_random_uuid(),
  order_id                uuid    not null references public.orders(id)            on delete cascade,
  variant_id              uuid    references public.product_variants(id)           on delete set null,
  title                   text    not null,
  sku                     text,
  quantity                int     not null check (quantity > 0),
  quantity_fulfilled      int     not null default 0,
  quantity_returned       int     not null default 0,
  price                   numeric(15,2) not null,
  total                   numeric(15,2) not null,
  discount_total          numeric(15,2) not null default 0,
  tax_total               numeric(15,2) not null default 0,
  fulfillment_status      text    not null default 'unfulfilled'
                            check (fulfillment_status in ('unfulfilled','partial','fulfilled','returned')),
  warehouse_id            uuid    references public.warehouses(id)                 on delete set null,
  fulfillment_provider_id uuid    references public.shipping_providers(id)         on delete set null,
  supplier_id             uuid    references public.suppliers(id)                  on delete set null,
  requires_shipping       boolean not null default true,
  is_digital              boolean not null default false,
  digital_url             text,
  is_gift_card            boolean not null default false,
  metadata                jsonb   not null default '{}',
  created_at              timestamptz not null default now()
);
comment on table public.order_lines is 'Order line items. warehouse_id + fulfillment_provider_id enable split-order routing.';
create index idx_order_lines_order   on public.order_lines(order_id);
create index idx_order_lines_variant on public.order_lines(variant_id) where variant_id is not null;

-- Serial numbers placed after order_lines so order_line_id FK can be defined inline
create table public.serial_numbers (
  id            uuid    primary key default gen_random_uuid(),
  variant_id    uuid    not null references public.product_variants(id) on delete cascade,
  warehouse_id  uuid    references public.warehouses(id)                on delete set null,
  serial_number text    not null,
  status        text    not null default 'available'
                  check (status in ('available','reserved','sold','returned','damaged')),
  order_line_id uuid    references public.order_lines(id)               on delete set null,
  lot_id        uuid    references public.inventory_lots(id)            on delete set null,
  metadata      jsonb   not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique(variant_id, serial_number)
);
comment on table public.serial_numbers is 'Per-unit serial tracking (electronics, firearms, luxury goods).';
create index idx_serials_variant on public.serial_numbers(variant_id);
create index idx_serials_status  on public.serial_numbers(status);

create table public.order_adjustments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id)      on delete cascade,
  order_line_id uuid references public.order_lines(id)          on delete cascade,
  type          text not null check (type in ('discount','fee','tip','tax_adjustment','other')),
  title         text not null,
  amount        numeric(15,2) not null,
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index idx_order_adjustments_order on public.order_adjustments(order_id);

create table public.order_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  type       text not null,
  data       jsonb not null default '{}',
  created_by uuid,   -- nullable, no FK
  created_at timestamptz not null default now()
);
comment on table public.order_events is 'Append-only order timeline.';
create index idx_order_events_order on public.order_events(order_id, created_at);

-- Discount usages placed after orders so order_id FK is available
create table public.discount_usages (
  id           uuid    primary key default gen_random_uuid(),
  discount_id  uuid    not null references public.discount_codes(id) on delete cascade,
  order_id     uuid    references public.orders(id)                  on delete set null,
  customer_id  uuid    references public.customers(id)               on delete set null,
  amount_saved numeric(15,2) not null,
  created_at   timestamptz not null default now()
);
create index idx_discount_usages_discount on public.discount_usages(discount_id);
create index idx_discount_usages_customer on public.discount_usages(customer_id) where customer_id is not null;
-- Prevents the once_per_customer race in CompleteCheckout (INSERT … ON CONFLICT DO NOTHING RETURNING 1).
create unique index if not exists ux_discount_usages_discount_customer
  on public.discount_usages(discount_id, customer_id)
  where customer_id is not null;

-- ============================================================================
-- 13. PAYMENTS
-- ============================================================================

create table public.payments (
  id                  uuid    primary key default gen_random_uuid(),
  order_id            uuid    not null references public.orders(id) on delete cascade,
  provider_id         uuid    references public.payment_providers(id) on delete set null,
  amount              numeric(15,2) not null,
  currency            char(3) not null,
  status              text    not null default 'pending'
                        check (status in (
                          'pending','authorized','captured','failed',
                          'voided','refunded','partially_refunded'
                        )),
  provider_reference  text,
  provider_session_id text,
  captured_at         timestamptz,
  is_test             boolean not null default false,
  mode                text    not null default 'live'
                        check (mode in ('live','dev')),
  metadata            jsonb   not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.payments is 'Payment records per order. Supports multiple payments (split payment).';
create index idx_payments_order    on public.payments(order_id);
create index idx_payments_status   on public.payments(status);
create index idx_payments_provider on public.payments(provider_id) where provider_id is not null;
-- Atomic webhook dedup: INSERT … ON CONFLICT DO NOTHING for duplicate provider events.
create unique index if not exists uq_payments_order_provider_reference
  on public.payments(order_id, provider_reference)
  where provider_reference is not null;

create table public.payment_attempts (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid not null references public.payments(id) on delete cascade,
  amount            numeric(15,2) not null,
  status            text not null,
  provider_response jsonb,
  error_message     text,
  ip_address        text,
  created_at        timestamptz not null default now()
);
comment on table public.payment_attempts is 'Raw attempt log per payment. Every retry, failure, and provider response recorded here.';
create index idx_payment_attempts_payment on public.payment_attempts(payment_id);

create table public.refunds (
  id                 uuid    primary key default gen_random_uuid(),
  payment_id         uuid    not null references public.payments(id) on delete cascade,
  order_id           uuid    not null references public.orders(id)   on delete cascade,
  amount             numeric(15,2) not null,
  reason             text    check (reason in ('customer_request','defective','not_received','other')),
  notes              text,
  status             text    not null default 'pending'
                       check (status in ('pending','processing','succeeded','failed')),
  provider_reference text,
  restock_inventory  boolean not null default true,
  created_by         uuid,   -- nullable, no FK
  metadata           jsonb   not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index idx_refunds_order   on public.refunds(order_id);
create index idx_refunds_payment on public.refunds(payment_id);
-- Idempotency for provider refund webhooks (Stripe charge.refunded, Paystack refund.processed, etc.)
create unique index if not exists uq_refunds_payment_provider_reference
  on public.refunds(payment_id, provider_reference)
  where provider_reference is not null;

create table public.refund_lines (
  id            uuid primary key default gen_random_uuid(),
  refund_id     uuid not null references public.refunds(id)     on delete cascade,
  order_line_id uuid not null references public.order_lines(id) on delete cascade,
  quantity      int  not null check (quantity > 0),
  amount        numeric(15,2) not null
);
create index idx_refund_lines_refund on public.refund_lines(refund_id);

-- Store credit wallet
create table public.store_credits (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id)    on delete cascade,
  customer_id uuid    not null references public.customers(id) on delete cascade,
  balance     numeric(15,2) not null default 0 check (balance >= 0),
  currency    char(3) not null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(store_id, customer_id, currency)
);
comment on table public.store_credits is 'Customer credit wallet per store/currency.';
create index idx_store_credits_customer on public.store_credits(customer_id);

create table public.store_credit_transactions (
  id              uuid primary key default gen_random_uuid(),
  store_credit_id uuid not null references public.store_credits(id) on delete cascade,
  order_id        uuid references public.orders(id) on delete set null,
  amount_delta    numeric(15,2) not null,
  balance_after   numeric(15,2) not null,
  type            text not null check (type in ('earn','redeem','expire','adjust','issue','return')),
  notes           text,
  created_by      uuid,   -- nullable, no FK
  created_at      timestamptz not null default now()
);
create index idx_store_credit_tx_credit on public.store_credit_transactions(store_credit_id);

-- ============================================================================
-- 14. SHIPMENTS
-- ============================================================================

create table public.shipments (
  id                  uuid    primary key default gen_random_uuid(),
  order_id            uuid    not null references public.orders(id) on delete cascade,
  provider_id         uuid    references public.shipping_providers(id)    on delete set null,
  warehouse_id        uuid    references public.warehouses(id)             on delete set null,
  collection_point_id uuid    references public.collection_points(id)     on delete set null,
  status              text    not null default 'pending'
                        check (status in (
                          'pending','picked','packed','dispatched',
                          'in_transit','out_for_delivery','delivered',
                          'failed_delivery','returned','cancelled'
                        )),
  tracking_number     text,
  tracking_url        text,
  carrier             text,
  service_level       text,
  provider_reference  text,
  label_url           text,
  shipped_at          timestamptz,
  estimated_delivery  date,
  delivered_at        timestamptz,
  metadata            jsonb   not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.shipments is 'A physical parcel dispatched for an order. One order can have multiple shipments (split fulfillment).';
create index idx_shipments_order    on public.shipments(order_id);
create index idx_shipments_status   on public.shipments(status);
create index idx_shipments_tracking on public.shipments(tracking_number) where tracking_number is not null;

create table public.shipment_lines (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references public.shipments(id)     on delete cascade,
  order_line_id uuid not null references public.order_lines(id)   on delete cascade,
  quantity      int  not null check (quantity > 0),
  lot_id        uuid references public.inventory_lots(id)         on delete set null,
  serial_id     uuid references public.serial_numbers(id)         on delete set null
);
create index idx_shipment_lines_shipment on public.shipment_lines(shipment_id);

create table public.shipment_tracking_events (
  id          uuid    primary key default gen_random_uuid(),
  shipment_id uuid    not null references public.shipments(id) on delete cascade,
  status      text    not null,
  location    text,
  description text,
  occurred_at timestamptz not null,
  raw_data    jsonb,
  created_at  timestamptz not null default now()
);
create index idx_tracking_events_shipment on public.shipment_tracking_events(shipment_id, occurred_at desc);

-- ============================================================================
-- 15. RETURNS / RMA
-- ============================================================================

create table public.return_requests (
  id          uuid    primary key default gen_random_uuid(),
  store_id    uuid    not null references public.stores(id)    on delete cascade,
  order_id    uuid    not null references public.orders(id)    on delete cascade,
  customer_id uuid    references public.customers(id)          on delete set null,
  rma_number  text,
  status      text    not null default 'requested'
                check (status in (
                  'requested','approved','rejected',
                  'in_transit','received','inspected','resolved','closed'
                )),
  return_type text    not null default 'refund'
                check (return_type in ('refund','exchange','store_credit','repair')),
  notes       text,
  metadata    jsonb   not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.return_requests is 'RMA/returns. return_type = repair covers warranty service orders.';
create index idx_return_requests_store on public.return_requests(store_id);
create index idx_return_requests_order on public.return_requests(order_id);

create table public.return_request_lines (
  id                  uuid primary key default gen_random_uuid(),
  return_id           uuid not null references public.return_requests(id) on delete cascade,
  order_line_id       uuid not null references public.order_lines(id)     on delete cascade,
  quantity            int  not null check (quantity > 0),
  reason              text check (reason in (
                        'defective','wrong_item','not_as_described',
                        'changed_mind','damaged_in_transit','other'
                      )),
  condition           text check (condition in ('new','good','fair','damaged','unsellable')),
  action              text not null default 'refund'
                        check (action in ('refund','exchange','store_credit','repair','discard')),
  exchange_variant_id uuid references public.product_variants(id) on delete set null,
  restock             boolean not null default true,
  created_at          timestamptz not null default now()
);
create index idx_return_lines_return on public.return_request_lines(return_id);

create table public.return_events (
  id         uuid primary key default gen_random_uuid(),
  return_id  uuid not null references public.return_requests(id) on delete cascade,
  type       text not null,
  data       jsonb not null default '{}',
  created_by uuid,   -- nullable, no FK
  created_at timestamptz not null default now()
);
create index idx_return_events_return on public.return_events(return_id, created_at);

-- ============================================================================
-- 16. SUBSCRIPTIONS
-- ============================================================================

create table public.subscription_plans (
  id             uuid    primary key default gen_random_uuid(),
  store_id       uuid    not null references public.stores(id) on delete cascade,
  name           text    not null,
  interval       text    not null check (interval in ('day','week','month','year')),
  interval_count int     not null default 1 check (interval_count > 0),
  trial_days     int     not null default 0,
  metadata       jsonb   not null default '{}',
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index idx_subscription_plans_store on public.subscription_plans(store_id);

create table public.subscriptions (
  id                   uuid    primary key default gen_random_uuid(),
  store_id             uuid    not null references public.stores(id)              on delete cascade,
  customer_id          uuid    not null references public.customers(id)           on delete cascade,
  plan_id              uuid    not null references public.subscription_plans(id)  on delete restrict,
  payment_provider_id  uuid    references public.payment_providers(id)            on delete set null,
  payment_method_token text,
  status               text    not null default 'active'
                         check (status in ('trialing','active','paused','past_due','cancelled','expired')),
  current_period_start timestamptz not null,
  current_period_end   timestamptz not null,
  next_billing_at      timestamptz,
  trial_ends_at        timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  metadata             jsonb   not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.subscriptions is 'Recurring subscriptions. next_billing_at drives the worker billing cron.';
create index idx_subscriptions_store    on public.subscriptions(store_id);
create index idx_subscriptions_customer on public.subscriptions(customer_id);
create index idx_subscriptions_billing  on public.subscriptions(next_billing_at) where status = 'active';

create table public.subscription_items (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id)     on delete cascade,
  variant_id      uuid not null references public.product_variants(id)  on delete restrict,
  quantity        int  not null default 1 check (quantity > 0),
  price           numeric(15,2) not null
);
create index idx_subscription_items_sub on public.subscription_items(subscription_id);

create table public.subscription_orders (
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  order_id        uuid not null references public.orders(id)        on delete cascade,
  billing_period  int  not null,
  primary key (subscription_id, order_id)
);

-- ============================================================================
-- 17. B2B: QUOTES & PURCHASE ORDERS
-- ============================================================================

create table public.quotes (
  id                 uuid    primary key default gen_random_uuid(),
  store_id           uuid    not null references public.stores(id)    on delete cascade,
  company_id         uuid    references public.companies(id)          on delete set null,
  customer_id        uuid    references public.customers(id)          on delete set null,
  status             text    not null default 'draft'
                       check (status in ('draft','sent','viewed','accepted','rejected','expired','converted')),
  expires_at         timestamptz,
  notes              text,
  converted_order_id uuid    references public.orders(id)             on delete set null,
  metadata           jsonb   not null default '{}',
  created_by         uuid,   -- nullable, no FK
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.quotes is 'RFQ / quote workflow. Accepted quotes convert to orders.';
create index idx_quotes_store   on public.quotes(store_id);
create index idx_quotes_company on public.quotes(company_id) where company_id is not null;

create table public.quote_lines (
  id         uuid    primary key default gen_random_uuid(),
  quote_id   uuid    not null references public.quotes(id)           on delete cascade,
  variant_id uuid    references public.product_variants(id)          on delete set null,
  title      text    not null,
  quantity   int     not null check (quantity > 0),
  price      numeric(15,2) not null,
  notes      text,
  created_at timestamptz not null default now()
);
create index idx_quote_lines_quote on public.quote_lines(quote_id);

create table public.purchase_orders (
  id         uuid    primary key default gen_random_uuid(),
  store_id   uuid    not null references public.stores(id)    on delete cascade,
  company_id uuid    references public.companies(id)          on delete set null,
  order_id   uuid    references public.orders(id)             on delete set null,
  po_number  text    not null,
  status     text    not null default 'pending'
               check (status in ('pending','approved','partially_fulfilled','fulfilled','cancelled')),
  notes      text,
  metadata   jsonb   not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, po_number)
);
comment on table public.purchase_orders is 'Customer-issued purchase orders for B2B orders.';
create index idx_purchase_orders_store   on public.purchase_orders(store_id);
create index idx_purchase_orders_company on public.purchase_orders(company_id) where company_id is not null;

-- ============================================================================
-- 18. GIFT CARDS
-- ============================================================================

create table public.gift_cards (
  id                 uuid    primary key default gen_random_uuid(),
  store_id           uuid    not null references public.stores(id)    on delete cascade,
  code               text    not null,
  initial_value      numeric(15,2) not null,
  balance            numeric(15,2) not null,
  currency           char(3) not null,
  issued_to          uuid    references public.customers(id)          on delete set null,
  issued_by_order_id uuid    references public.orders(id)             on delete set null,
  expires_at         timestamptz,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique(store_id, code)
);
create index idx_gift_cards_store    on public.gift_cards(store_id);
create index idx_gift_cards_customer on public.gift_cards(issued_to) where issued_to is not null;

create table public.gift_card_transactions (
  id            uuid    primary key default gen_random_uuid(),
  gift_card_id  uuid    not null references public.gift_cards(id) on delete cascade,
  order_id      uuid    references public.orders(id) on delete set null,
  amount_delta  numeric(15,2) not null,
  balance_after numeric(15,2) not null,
  created_at    timestamptz not null default now()
);
create index idx_gc_tx_card on public.gift_card_transactions(gift_card_id);

-- ============================================================================
-- 19. INTEGRATIONS
-- ============================================================================

-- Integration definitions (catalogue — shared across all orgs)
create table public.integration_definitions (
  id               uuid        primary key default gen_random_uuid(),
  slug             text        not null unique,
  name             text        not null,
  category         text        not null
                     check (category in (
                       'shopping_channel','booking_channel','accounting',
                       'marketing','crm','shipping_carrier','fulfillment',
                       'pos','marketplace','payment_gateway','analytics',
                       'tag_management','communication','erp','review',
                       'loyalty','support','search','automation','custom'
                     )),
  auth_type        text        not null default 'api_key'
                     check (auth_type in ('oauth2','api_key','basic_auth','webhook_only','none')),
  config_schema    jsonb       not null default '{}',
  capabilities     text[]      not null default '{}',
  supported_events text[]      not null default '{}',
  docs_url         text,
  logo_url         text,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.integration_definitions is 'Catalogue of all supported integration types. Shared across all orgs.';
create index idx_integration_definitions_category on public.integration_definitions(category);
create index idx_integration_definitions_slug     on public.integration_definitions(slug);

-- Seed known integrations
insert into public.integration_definitions
  (slug, name, category, auth_type, capabilities, supported_events)
values
  ('google_shopping',     'Google Shopping',           'shopping_channel', 'oauth2',       '{sync_products,sync_inventory,generate_feed}', '{product.created,product.updated,product.deleted,inventory.adjusted}'),
  ('facebook_catalog',    'Facebook / Instagram Shop', 'shopping_channel', 'oauth2',       '{sync_products,sync_inventory,generate_feed}', '{product.created,product.updated,product.deleted}'),
  ('tiktok_shop',         'TikTok Shop',               'shopping_channel', 'oauth2',       '{sync_products,sync_orders,sync_inventory}',   '{product.created,product.updated,order.created,order.updated}'),
  ('microsoft_shopping',  'Microsoft Shopping',        'shopping_channel', 'oauth2',       '{sync_products,generate_feed}',                '{product.created,product.updated,product.deleted}'),
  ('pinterest',           'Pinterest Catalog',         'shopping_channel', 'oauth2',       '{sync_products,generate_feed}',                '{product.created,product.updated,product.deleted}'),
  ('amazon',              'Amazon Marketplace',        'marketplace',      'api_key',      '{sync_products,sync_orders,sync_inventory,sync_shipments}', '{order.created,order.updated,inventory.adjusted}'),
  ('takealot',            'Takealot',                  'marketplace',      'api_key',      '{sync_products,sync_orders,sync_inventory}',   '{order.created,order.updated}'),
  ('jumia',               'Jumia',                     'marketplace',      'api_key',      '{sync_products,sync_orders}',                  '{order.created,order.updated}'),
  ('airbnb',              'Airbnb',                    'booking_channel',  'oauth2',       '{sync_listings,sync_availability,sync_rates,receive_reservations}', '{booking.created,booking.updated,booking.cancelled,availability.updated}'),
  ('booking_com',         'Booking.com',               'booking_channel',  'api_key',      '{sync_listings,sync_availability,sync_rates,receive_reservations}', '{booking.created,booking.updated,booking.cancelled,availability.updated}'),
  ('expedia',             'Expedia',                   'booking_channel',  'oauth2',       '{sync_listings,sync_availability,sync_rates,receive_reservations}', '{booking.created,booking.updated,booking.cancelled}'),
  ('vrbo',                'VRBO',                      'booking_channel',  'oauth2',       '{sync_listings,sync_availability,sync_rates,receive_reservations}', '{booking.created,booking.updated,booking.cancelled}'),
  ('quickbooks',          'QuickBooks Online',         'accounting',       'oauth2',       '{sync_customers,sync_invoices,sync_payments,sync_products}', '{order.created,payment.captured,refund.created,customer.created}'),
  ('xero',                'Xero',                      'accounting',       'oauth2',       '{sync_customers,sync_invoices,sync_payments}',  '{order.created,payment.captured,refund.created}'),
  ('mailchimp',           'Mailchimp',                 'marketing',        'api_key',      '{sync_customers,sync_orders,sync_products}',   '{customer.created,order.created,order.completed}'),
  ('klaviyo',             'Klaviyo',                   'marketing',        'api_key',      '{sync_customers,sync_events,sync_products}',   '{customer.created,order.created,order.completed,cart.abandoned}'),
  ('google_analytics',    'Google Analytics 4',        'analytics',        'oauth2',       '{track_events,sync_conversions}',              '{order.created,checkout.started,product.viewed}'),
  ('zapier',              'Zapier',                    'automation',       'webhook_only', '{receive_events}',                             '{order.created,order.updated,customer.created,product.updated}'),
  ('shopify',             'Shopify (import/sync)',      'marketplace',      'api_key',      '{import_products,import_orders,import_customers}', '{}'),
  ('google_tag_manager',  'Google Tag Manager',        'tag_management',   'none',         '{inject_container}',                           '{}'),
  ('mixpanel',            'Mixpanel',                  'analytics',        'api_key',      '{track_events,sync_users}',                    '{order.created,checkout.started,product.viewed,customer.created}'),
  ('segment',             'Segment',                   'analytics',        'api_key',      '{track_events,sync_users,forward_events}',      '{order.created,checkout.started,product.viewed,customer.created,cart.abandoned}'),
  ('hubspot',             'HubSpot CRM',               'crm',              'oauth2',       '{sync_customers,sync_orders,sync_companies,sync_deals}', '{customer.created,order.created,order.completed,customer.updated}'),
  ('algolia',             'Algolia',                   'search',           'api_key',      '{index_products,sync_inventory,instant_search}', '{product.created,product.updated,product.deleted,inventory.adjusted}'),
  ('shippo',              'Shippo',                    'shipping_carrier', 'api_key',      '{create_shipments,get_rates,print_labels,track_shipments}', '{order.created,shipment.created}'),
  ('bob_go',              'Bobgo',                     'shipping_carrier', 'api_key',      '{create_shipments,get_rates,track_shipments}', '{shipment.created}'),
  ('avalara',             'Avalara AvaTax',             'erp',              'api_key',      '{calculate_tax,file_returns,validate_addresses}', '{order.created,order.updated}'),
  ('woocommerce',         'WooCommerce (import/sync)',  'marketplace',      'api_key',      '{import_products,import_orders,import_customers,sync_inventory}', '{order.created,product.updated}'),
  ('flutterwave',         'Flutterwave',               'payment_gateway',  'api_key',      '{process_payments,receive_webhooks}',          '{payment.captured,refund.created}'),
  ('payfast',             'PayFast',                   'payment_gateway',  'api_key',      '{process_payments,receive_webhooks}',          '{payment.captured,refund.created}'),
  ('square',              'Square POS',                'pos',              'oauth2',       '{sync_products,sync_inventory,sync_orders,sync_customers}', '{order.created,inventory.adjusted,customer.created}'),
  ('trustpilot',          'Trustpilot',                'review',           'oauth2',       '{invite_reviewers,sync_reviews,display_widgets}', '{order.completed,order.delivered}'),
  ('smile_io',            'Smile.io',                  'loyalty',          'api_key',      '{sync_customers,sync_orders,award_points,redeem_rewards}', '{order.created,order.completed,customer.created,refund.created}'),
  ('intercom',            'Intercom',                  'support',          'oauth2',       '{sync_customers,create_conversations,inject_widget}', '{customer.created,order.created,order.completed}'),
  ('twilio',              'Twilio SMS / Voice',         'communication',    'api_key',      '{send_sms,send_voice,send_whatsapp}',          '{order.created,order.shipped,order.delivered,booking.confirmed}'),
  ('sendgrid',            'Twilio SendGrid',            'communication',    'api_key',      '{send_transactional,send_marketing}',          '{order.created,order.shipped,order.delivered,customer.created}'),
  ('make',                'Make (Integromat)',          'automation',       'webhook_only', '{receive_events,trigger_scenarios}',           '{order.created,order.updated,customer.created,product.updated,booking.created}'),
  ('n8n',                 'n8n',                        'automation',       'webhook_only', '{receive_events}',                             '{order.created,order.updated,customer.created,product.updated}')
on conflict (slug) do nothing;

-- Store integrations (per-store installation of an integration)
create table public.store_integrations (
  id                   uuid        primary key default gen_random_uuid(),
  store_id             uuid        not null references public.stores(id)                       on delete cascade,
  integration_slug     text        not null references public.integration_definitions(slug)    on delete restrict,
  name                 text        not null,
  api_key              text,
  api_secret           text,
  access_token         text,
  refresh_token        text,
  token_expires_at     timestamptz,
  webhook_secret       text,
  oauth_account_id     text,
  oauth_account_name   text,
  config               jsonb       not null default '{}',
  status               text        not null default 'active'
                         check (status in ('pending_auth','active','paused','error','disconnected')),
  last_synced_at       timestamptz,
  last_error           text,
  scopes               text[]      not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table  public.store_integrations      is 'Per-store integration installations. Multi-instance: a store may have any number of installs of the same provider keyed by (store_id, integration_slug, lower(name)).';
comment on column public.store_integrations.name is 'Required, user-supplied friendly label. Unique per (store_id, integration_slug) when lower-cased.';
create index idx_store_integrations_store  on public.store_integrations(store_id);
create index idx_store_integrations_slug   on public.store_integrations(store_id, integration_slug);
create index idx_store_integrations_status on public.store_integrations(status) where status = 'error';
create unique index uq_store_integrations_store_slug_name
  on public.store_integrations(store_id, integration_slug, lower(name));

-- Integration webhooks
create table public.integration_webhooks (
  id                   uuid        primary key default gen_random_uuid(),
  store_integration_id uuid        not null references public.store_integrations(id) on delete cascade,
  direction            text        not null check (direction in ('inbound','outbound')),
  event                text        not null,
  url                  text,
  secret               text        default encode(gen_random_bytes(32), 'hex'),
  endpoint_token       text        unique default encode(gen_random_bytes(24), 'hex'),
  is_active            boolean     not null default true,
  last_triggered_at    timestamptz,
  last_status_code     int,
  last_error           text,
  max_retries          int         not null default 3,
  retry_backoff_minutes int        not null default 5,
  retry_count          int         not null default 0,
  next_retry_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (direction = 'inbound' or url is not null)
);
comment on table public.integration_webhooks is 'Event subscriptions per integration. outbound = we POST to external URL. inbound = external service POSTs to our endpoint.';
create index idx_integration_webhooks_integration on public.integration_webhooks(store_integration_id);
create index idx_integration_webhooks_event       on public.integration_webhooks(event, is_active);
create index idx_integration_webhooks_token       on public.integration_webhooks(endpoint_token) where endpoint_token is not null;

-- Metafields (Shopify-style per-resource extensible key-value)
create table public.metafields (
  id             uuid        primary key default gen_random_uuid(),
  store_id       uuid        not null references public.stores(id) on delete cascade,
  owner_resource text        not null
                   check (owner_resource in (
                     'store','product','variant','collection',
                     'order','order_line','customer','company',
                     'booking','booking_resource','shipment','return'
                   )),
  owner_id       uuid        not null,
  namespace      text        not null,
  key            text        not null,
  value_type     text        not null default 'string'
                   check (value_type in ('string','integer','decimal','boolean','json','date','datetime')),
  value          text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(store_id, owner_resource, owner_id, namespace, key)
);
comment on table public.metafields is 'Shopify-style per-resource key-value store. Integrations attach external IDs and data without schema changes.';
create index idx_metafields_owner  on public.metafields(owner_resource, owner_id);
create index idx_metafields_ns_key on public.metafields(store_id, namespace, key);
create index idx_metafields_store  on public.metafields(store_id);

-- Metafield definitions
create table public.metafield_definitions (
  id             uuid        primary key default gen_random_uuid(),
  store_id       uuid        not null references public.stores(id) on delete cascade,
  owner_resource text        not null
                   check (owner_resource in (
                     'store','product','variant','collection',
                     'order','order_line','customer','company',
                     'booking','booking_resource','shipment','return'
                   )),
  namespace      text        not null,
  key            text        not null,
  name           text        not null,
  description    text,
  value_type     text        not null default 'string'
                   check (value_type in ('string','integer','decimal','boolean','json','date','datetime')),
  validations    jsonb       not null default '{}',
  is_required    boolean     not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(store_id, owner_resource, namespace, key)
);
comment on table public.metafield_definitions is 'Schema definitions for metafields — drives UI validation and typed editors.';
create index idx_metafield_definitions_store    on public.metafield_definitions(store_id);
create index idx_metafield_definitions_resource on public.metafield_definitions(store_id, owner_resource);

-- Product feed data (Google Shopping / Facebook Catalog structured fields)
create table public.product_feed_data (
  id                    uuid        primary key default gen_random_uuid(),
  variant_id            uuid        not null references public.product_variants(id) on delete cascade,
  gtin                  text,
  mpn                   text,
  brand                 text,
  google_product_category text,
  condition             text        not null default 'new'
                          check (condition in ('new','refurbished','used')),
  age_group             text        check (age_group  in ('newborn','infant','toddler','kids','adult')),
  gender                text        check (gender     in ('male','female','unisex')),
  size_type             text        check (size_type  in ('regular','petite','plus','tall','big','maternity')),
  size_system           text,
  material              text,
  pattern               text,
  multipack             int,
  is_bundle             boolean     not null default false,
  custom_label_0        text,
  custom_label_1        text,
  custom_label_2        text,
  custom_label_3        text,
  custom_label_4        text,
  image_url             text,
  additional_image_urls text[]      not null default '{}',
  excluded_destinations text[]      not null default '{}',
  included_destinations text[]      not null default '{}',
  ads_redirect          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(variant_id)
);
comment on table public.product_feed_data is 'Structured Google Shopping / Facebook Catalog feed attributes per variant.';
create index idx_product_feed_data_variant on public.product_feed_data(variant_id);

create table public.product_feed_translations (
  id           uuid        primary key default gen_random_uuid(),
  feed_data_id uuid        not null references public.product_feed_data(id) on delete cascade,
  locale       text        not null,
  title        text,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique(feed_data_id, locale)
);
create index idx_product_feed_translations_feed on public.product_feed_translations(feed_data_id);

-- Merchant feeds (per store + channel + locale + country)
create table public.merchant_feeds (
  id                          uuid        primary key default gen_random_uuid(),
  store_id                    uuid        not null references public.stores(id) on delete cascade,
  store_integration_id        uuid        references public.store_integrations(id) on delete set null,
  channel                     text        not null
                                check (channel in (
                                  'google_shopping','facebook_catalog','tiktok_shop',
                                  'pinterest','microsoft_shopping','snapchat','custom'
                                )),
  name                        text        not null,
  format                      text        not null default 'xml'
                                check (format in ('xml','tsv','json','csv')),
  locale                      text        not null default 'en',
  currency                    char(3)     not null,
  country_code                char(2)     not null,
  include_out_of_stock        boolean     not null default false,
  generation_interval_minutes int         not null default 60,
  last_generated_at           timestamptz,
  status                      text        not null default 'active'
                                check (status in ('active','paused','error')),
  error_log                   jsonb,
  config                      jsonb       not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique(store_id, channel, locale, country_code)
);
comment on table public.merchant_feeds is 'Shopping channel feed configuration per store.';
create index idx_merchant_feeds_store       on public.merchant_feeds(store_id);
create index idx_merchant_feeds_integration on public.merchant_feeds(store_integration_id) where store_integration_id is not null;

create table public.feed_shipping_overrides (
  id           uuid        primary key default gen_random_uuid(),
  feed_id      uuid        not null references public.merchant_feeds(id) on delete cascade,
  country_code char(2)     not null,
  service_name text        not null,
  price_type   text        not null default 'flat'
                 check (price_type in ('flat','free','calculated')),
  price        numeric(15,2),
  min_days     int,
  max_days     int,
  created_at   timestamptz not null default now(),
  unique(feed_id, country_code, service_name)
);
comment on table public.feed_shipping_overrides is 'Shipping spec entries embedded in merchant feed files.';
create index idx_feed_shipping_overrides_feed on public.feed_shipping_overrides(feed_id);

-- Webhook delivery log (outbound integration webhooks)
create table public.webhook_delivery_log (
  id                   uuid        primary key default gen_random_uuid(),
  webhook_id           uuid        not null references public.integration_webhooks(id) on delete cascade,
  store_integration_id uuid        references public.store_integrations(id) on delete set null,
  event                text        not null,
  payload              jsonb       not null default '{}',
  attempt_number       int         not null default 1,
  status_code          int,
  response_body        text        check (response_body is null or octet_length(response_body) <= 65536),
  error_message        text,
  duration_ms          int,
  delivered_at         timestamptz not null default now()
);
comment on table public.webhook_delivery_log is 'Delivery attempt log for outbound integration webhooks.';
create index idx_wh_delivery_log_webhook on public.webhook_delivery_log(webhook_id, delivered_at desc);
create index idx_wh_delivery_log_event   on public.webhook_delivery_log(event, delivered_at desc);
create index idx_wh_delivery_log_failed  on public.webhook_delivery_log(webhook_id)
  where status_code is null or status_code >= 400;

-- Integration sync logs
create table public.integration_sync_logs (
  id                   uuid        primary key default gen_random_uuid(),
  store_integration_id uuid        not null references public.store_integrations(id) on delete cascade,
  sync_type            text        not null,
  direction            text        not null default 'outbound'
                         check (direction in ('inbound','outbound','bidirectional')),
  status               text        not null default 'running'
                         check (status in ('running','success','partial','error')),
  records_processed    int         not null default 0,
  records_failed       int         not null default 0,
  error_summary        text,
  details              jsonb       not null default '{}',
  started_at           timestamptz not null default now(),
  completed_at         timestamptz
);
comment on table public.integration_sync_logs is 'Sync run audit log per integration.';
create index idx_integration_sync_logs_integration on public.integration_sync_logs(store_integration_id, started_at desc);
create index idx_integration_sync_logs_status      on public.integration_sync_logs(status) where status in ('running','error');

-- Store integration sync log (per-run, richer than integration_sync_logs)
create table public.store_integration_sync_log (
  id                   uuid        primary key default gen_random_uuid(),
  store_integration_id uuid        not null references public.store_integrations(id) on delete cascade,
  sync_type            text        not null,
  direction            text        not null default 'outbound'
                         check (direction in ('inbound','outbound','bidirectional')),
  records_attempted    int         not null default 0,
  records_succeeded    int         not null default 0,
  records_failed       int         not null default 0,
  records_skipped      int         not null default 0,
  status               text        not null default 'running'
                         check (status in ('running','success','partial','failed','cancelled')),
  error                text,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  duration_ms          bigint generated always as (
                         extract(epoch from (finished_at - started_at)) * 1000
                       ) stored,
  metadata             jsonb       not null default '{}'
);
comment on table public.store_integration_sync_log is 'Per-run sync history for any integration.';
create index idx_int_sync_log_integration on public.store_integration_sync_log(store_integration_id, started_at desc);
create index idx_int_sync_log_status      on public.store_integration_sync_log(status)
  where status in ('running','failed');

-- OAuth states for integration flows
create table public.store_integration_oauth_states (
  id                   uuid        primary key default gen_random_uuid(),
  store_id             uuid        not null references public.stores(id) on delete cascade,
  integration_slug     text        not null references public.integration_definitions(slug) on delete cascade,
  state                text        not null unique default encode(gen_random_bytes(24), 'hex'),
  code_verifier        text,
  redirect_uri         text        not null,
  store_integration_id uuid        references public.store_integrations(id) on delete set null,
  expires_at           timestamptz not null default (now() + interval '15 minutes'),
  used_at              timestamptz,
  created_at           timestamptz not null default now()
);
comment on table public.store_integration_oauth_states is 'Transient OAuth2 PKCE state for integration authorization flows. Expires after 15 minutes.';
create index idx_int_oauth_store   on public.store_integration_oauth_states(store_id);
create index idx_int_oauth_state   on public.store_integration_oauth_states(state);
create index idx_int_oauth_expires on public.store_integration_oauth_states(expires_at) where used_at is null;

-- Tracking pixels
create table public.store_tracking_pixels (
  id              uuid        primary key default gen_random_uuid(),
  store_id        uuid        not null references public.stores(id) on delete cascade,
  pixel_type      text        not null
                    check (pixel_type in (
                      'google_analytics_4','google_tag_manager','meta_pixel',
                      'tiktok_pixel','snapchat_pixel','pinterest_tag','twitter_pixel',
                      'microsoft_clarity','hotjar','mixpanel','segment',
                      'intercom','zendesk','tidio','crisp','freshdesk','custom_script'
                    )),
  name            text        not null,
  tracking_id     text        not null,
  api_secret      text,
  access_token    text,
  fire_on         text        not null default 'all'
                    check (fire_on in ('all','checkout','product','collection','order_confirm','custom')),
  url_pattern     text,
  event_mapping   jsonb       not null default '{}',
  script_content  text,
  inject_location text        not null default 'head'
                    check (inject_location in ('head','body_start','body_end')),
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.store_tracking_pixels is 'Client-side pixel and tag configs injected into storefront pages.';
create unique index idx_tracking_pixels_store_type on public.store_tracking_pixels(store_id, pixel_type);
create index idx_tracking_pixels_store on public.store_tracking_pixels(store_id, is_active);

-- Payment provider webhook log (inbound — separate from outbound delivery log)
create table public.payment_provider_webhook_log (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  provider_id  uuid,
  provider_type text not null,
  provider_ref text not null default '',
  method       text not null,
  path         text not null,
  headers      jsonb not null default '{}',
  body         text not null default '',
  status_code  int  not null default 0,
  message      text not null default '',
  duration_ms  bigint not null default 0,
  created_at   timestamptz not null default now()
);
comment on table public.payment_provider_webhook_log is
  'Append-only log of inbound webhooks from payment providers. '
  'Each row = one inbound request. Used for debugging, replay, and audit.';
create index idx_payment_provider_webhook_log_store    on public.payment_provider_webhook_log(store_id, created_at desc);
create index idx_payment_provider_webhook_log_provider on public.payment_provider_webhook_log(provider_id, created_at desc)
  where provider_id is not null;
create index idx_payment_provider_webhook_log_status   on public.payment_provider_webhook_log(status_code, created_at desc)
  where status_code >= 400;

-- Webhook replay guard (custom-webhook idempotency)
create table public.webhook_replay_guard (
  provider_id uuid        not null,
  body_hash   text        not null,
  received_at timestamptz not null default now(),
  primary key (provider_id, body_hash)
);
create index idx_webhook_replay_guard_received_at on public.webhook_replay_guard(received_at);

-- ============================================================================
-- 20. COMMERCE GAPS (automatic discounts, collection rules, abandoned carts,
--     digital products, reviews, wishlists, fulfillment orders, tags)
-- ============================================================================

-- Automatic discounts (codeless, evaluated at checkout)
create table public.automatic_discounts (
  id                    uuid        primary key default gen_random_uuid(),
  store_id              uuid        not null references public.stores(id) on delete cascade,
  title                 text        not null,
  type                  text        not null
                          check (type in (
                            'percentage','fixed_amount','free_shipping',
                            'bogo','buy_x_get_y'
                          )),
  value                 numeric(15,4),
  min_order_total       numeric(15,2),
  min_qty               int,
  max_discount          numeric(15,2),
  max_uses              int,
  uses_count            int         not null default 0,
  once_per_customer     boolean     not null default false,
  applies_to            text        not null default 'order'
                          check (applies_to in (
                            'order','specific_products',
                            'specific_collections','customer_group'
                          )),
  applies_to_ids        uuid[]      not null default '{}',
  customer_eligibility  text        not null default 'all'
                          check (customer_eligibility in ('all','specific_customers','customer_groups')),
  eligible_ids          uuid[]      not null default '{}',
  allow_stacking        boolean     not null default false,
  priority              int         not null default 0,
  metadata              jsonb       not null default '{}',
  starts_at             timestamptz,
  ends_at               timestamptz,
  is_active             boolean     not null default true,
  created_by            uuid,   -- nullable, no FK
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.automatic_discounts is 'Codeless automatic promotions applied at checkout.';
create index idx_auto_discounts_store  on public.automatic_discounts(store_id);
create index idx_auto_discounts_active on public.automatic_discounts(store_id, is_active, starts_at, ends_at);

-- Collection rules (smart collection membership)
create table public.collection_rules (
  id            uuid        primary key default gen_random_uuid(),
  collection_id uuid        not null references public.collections(id) on delete cascade,
  field         text        not null
                  check (field in (
                    'title','tag','type','vendor',
                    'price','compare_at_price','weight',
                    'inventory_total','variant_title','status'
                  )),
  relation      text        not null
                  check (relation in (
                    'equals','not_equals','contains','not_contains',
                    'starts_with','ends_with',
                    'greater_than','less_than',
                    'is_set','is_not_set'
                  )),
  value         text        not null default '',
  position      int         not null default 0,
  created_at    timestamptz not null default now()
);
comment on table public.collection_rules is 'Rules governing automatic product membership in a smart collection.';
create index idx_collection_rules_collection on public.collection_rules(collection_id);

-- Abandoned carts
create table public.abandoned_carts (
  id                 uuid        primary key default gen_random_uuid(),
  store_id           uuid        not null references public.stores(id)    on delete cascade,
  cart_id            uuid        not null references public.carts(id)     on delete cascade,
  customer_id        uuid        references public.customers(id)          on delete set null,
  email              text,
  abandoned_at       timestamptz not null default now(),
  recovery_token     text        not null unique default encode(gen_random_bytes(24), 'hex'),
  recovered_at       timestamptz,
  recovery_order_id  uuid        references public.orders(id)             on delete set null,
  last_notified_at   timestamptz,
  notification_count int         not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.abandoned_carts is 'Carts abandoned without checkout. recovery_token embedded in recovery email links.';
create unique index idx_abandoned_carts_cart    on public.abandoned_carts(cart_id);
create index idx_abandoned_carts_store          on public.abandoned_carts(store_id);
create index idx_abandoned_carts_customer       on public.abandoned_carts(customer_id) where customer_id is not null;
create index idx_abandoned_carts_unrecovered    on public.abandoned_carts(store_id, abandoned_at) where recovered_at is null;

-- Digital product files
create table public.digital_product_files (
  id             uuid        primary key default gen_random_uuid(),
  store_id       uuid        not null references public.stores(id) on delete cascade,
  product_id     uuid        references public.products(id)         on delete cascade,
  variant_id     uuid        references public.product_variants(id) on delete cascade,
  name           text        not null,
  file_url       text        not null,
  file_size      bigint,
  mime_type      text,
  version        text,
  download_limit int,
  is_active      boolean     not null default true,
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (product_id is not null or variant_id is not null)
);
comment on table public.digital_product_files is 'Files attached to digital products or specific variants.';
create index idx_digital_files_product on public.digital_product_files(product_id) where product_id is not null;
create index idx_digital_files_variant on public.digital_product_files(variant_id) where variant_id is not null;

-- Digital download links (post-purchase, time/count-limited)
create table public.digital_download_links (
  id                 uuid        primary key default gen_random_uuid(),
  store_id           uuid        not null references public.stores(id)             on delete cascade,
  order_id           uuid        not null references public.orders(id)             on delete cascade,
  order_line_id      uuid        references public.order_lines(id)                 on delete cascade,
  file_id            uuid        not null references public.digital_product_files(id) on delete cascade,
  customer_id        uuid        references public.customers(id)                   on delete set null,
  token              text        not null unique default encode(gen_random_bytes(32), 'hex'),
  download_count     int         not null default 0,
  max_downloads      int,
  expires_at         timestamptz,
  last_downloaded_at timestamptz,
  created_at         timestamptz not null default now()
);
comment on table public.digital_download_links is 'Scoped download URLs generated after purchase. Expired or over-limit links return 403.';
create index idx_download_links_order    on public.digital_download_links(order_id);
create index idx_download_links_customer on public.digital_download_links(customer_id) where customer_id is not null;
create index idx_download_links_token    on public.digital_download_links(token);

-- Product reviews
create table public.product_reviews (
  id                   uuid        primary key default gen_random_uuid(),
  store_id             uuid        not null references public.stores(id)    on delete cascade,
  product_id           uuid        not null references public.products(id)  on delete cascade,
  customer_id          uuid        references public.customers(id)          on delete set null,
  order_id             uuid        references public.orders(id)             on delete set null,
  rating               int         not null check (rating between 1 and 5),
  title                text,
  body                 text,
  reviewer_name        text,
  reviewer_email       text,
  status               text        not null default 'pending'
                         check (status in ('pending','approved','rejected','spam')),
  is_verified_purchase boolean     not null default false,
  helpful_count        int         not null default 0,
  media_urls           text[]      not null default '{}',
  reply                text,
  replied_at           timestamptz,
  metadata             jsonb       not null default '{}',
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.product_reviews is 'Customer product reviews. is_verified_purchase set when order_id links to a confirmed order.';
create index idx_product_reviews_product on public.product_reviews(product_id);
create index idx_product_reviews_store   on public.product_reviews(store_id, status);
create index idx_product_reviews_order   on public.product_reviews(order_id) where order_id is not null;

-- Wishlists
create table public.wishlists (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id) on delete cascade,
  customer_id uuid        references public.customers(id)       on delete cascade,
  session_id  text,
  name        text        not null default 'My Wishlist',
  is_public   boolean     not null default false,
  share_token text        unique default encode(gen_random_bytes(16), 'hex'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (customer_id is not null or session_id is not null)
);
comment on table public.wishlists is 'Customer or guest wishlist. is_public wishlists shareable via share_token.';
create index idx_wishlists_store    on public.wishlists(store_id);
create index idx_wishlists_customer on public.wishlists(customer_id) where customer_id is not null;

create table public.wishlist_items (
  id          uuid        primary key default gen_random_uuid(),
  wishlist_id uuid        not null references public.wishlists(id)        on delete cascade,
  product_id  uuid        not null references public.products(id)         on delete cascade,
  variant_id  uuid        references public.product_variants(id)          on delete set null,
  note        text,
  added_at    timestamptz not null default now(),
  unique (wishlist_id, product_id, variant_id)
);
comment on table public.wishlist_items is 'Items saved to a wishlist. variant_id optional.';
create index idx_wishlist_items_list on public.wishlist_items(wishlist_id);

-- Fulfillment orders (per-warehouse routing)
create table public.fulfillment_orders (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id)    on delete cascade,
  order_id         uuid        not null references public.orders(id)    on delete cascade,
  warehouse_id     uuid        references public.warehouses(id)          on delete set null,
  status           text        not null default 'open'
                     check (status in (
                       'open','in_progress','fulfilled',
                       'cancelled','on_hold','incomplete'
                     )),
  request_status   text        not null default 'unsubmitted'
                     check (request_status in (
                       'unsubmitted','submitted','accepted','rejected',
                       'cancellation_requested','cancellation_accepted','cancellation_rejected'
                     )),
  assigned_to      uuid,   -- nullable, no FK
  shipment_id      uuid        references public.shipments(id)           on delete set null,
  fulfill_by       timestamptz,
  fulfilled_at     timestamptz,
  cancelled_at     timestamptz,
  notes            text,
  metadata         jsonb       not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.fulfillment_orders is 'Per-warehouse fulfillment unit within an order. One order may have multiple fulfillment orders.';
create index idx_fulfillment_orders_order     on public.fulfillment_orders(order_id);
create index idx_fulfillment_orders_store     on public.fulfillment_orders(store_id, status);
create index idx_fulfillment_orders_warehouse on public.fulfillment_orders(warehouse_id) where warehouse_id is not null;

create table public.fulfillment_order_lines (
  id                   uuid        primary key default gen_random_uuid(),
  fulfillment_order_id uuid        not null references public.fulfillment_orders(id) on delete cascade,
  order_line_id        uuid        not null references public.order_lines(id)        on delete cascade,
  quantity             int         not null check (quantity > 0),
  quantity_fulfilled   int         not null default 0 check (quantity_fulfilled >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (fulfillment_order_id, order_line_id)
);
comment on table public.fulfillment_order_lines is 'Line items within a fulfillment order.';
create index idx_fulfillment_lines_fo on public.fulfillment_order_lines(fulfillment_order_id);

-- Product tags
create table public.product_tags (
  product_id uuid not null references public.products(id)  on delete cascade,
  tag        text not null check (length(tag) between 1 and 100),
  primary key (product_id, tag)
);
comment on table public.product_tags is 'Product tags for filtering, smart collections, and search.';
create index idx_product_tags_tag on public.product_tags(tag);

-- Customer tags
create table public.customer_tags (
  customer_id uuid not null references public.customers(id) on delete cascade,
  tag         text not null check (length(tag) between 1 and 100),
  primary key (customer_id, tag)
);
comment on table public.customer_tags is 'Customer tags for segmentation and discount targeting.';
create index idx_customer_tags_tag on public.customer_tags(tag);

-- ============================================================================
-- 21. UPDATED_AT TRIGGERS
-- ============================================================================

create trigger stores_updated_at                    before update on public.stores                    for each row execute function public.set_updated_at();
create trigger payment_providers_updated_at         before update on public.payment_providers         for each row execute function public.set_updated_at();
create trigger shipping_providers_updated_at        before update on public.shipping_providers        for each row execute function public.set_updated_at();
create trigger tax_providers_updated_at             before update on public.tax_providers             for each row execute function public.set_updated_at();
create trigger notification_providers_updated_at    before update on public.notification_providers    for each row execute function public.set_updated_at();
create trigger products_updated_at                  before update on public.products                  for each row execute function public.set_updated_at();
create trigger product_variants_updated_at          before update on public.product_variants          for each row execute function public.set_updated_at();
create trigger collections_updated_at               before update on public.collections               for each row execute function public.set_updated_at();
create trigger price_lists_updated_at               before update on public.price_lists               for each row execute function public.set_updated_at();
create trigger warehouses_updated_at                before update on public.warehouses                for each row execute function public.set_updated_at();
create trigger inventory_levels_updated_at          before update on public.inventory_levels          for each row execute function public.set_updated_at();
create trigger serial_numbers_updated_at            before update on public.serial_numbers            for each row execute function public.set_updated_at();
create trigger customers_updated_at                 before update on public.customers                 for each row execute function public.set_updated_at();
create trigger companies_updated_at                 before update on public.companies                 for each row execute function public.set_updated_at();
create trigger carts_updated_at                     before update on public.carts                     for each row execute function public.set_updated_at();
create trigger cart_lines_updated_at                before update on public.cart_lines                for each row execute function public.set_updated_at();
create trigger checkouts_updated_at                 before update on public.checkouts                 for each row execute function public.set_updated_at();
create trigger orders_updated_at                    before update on public.orders                    for each row execute function public.set_updated_at();
create trigger payments_updated_at                  before update on public.payments                  for each row execute function public.set_updated_at();
create trigger refunds_updated_at                   before update on public.refunds                   for each row execute function public.set_updated_at();
create trigger store_credits_updated_at             before update on public.store_credits             for each row execute function public.set_updated_at();
create trigger shipments_updated_at                 before update on public.shipments                 for each row execute function public.set_updated_at();
create trigger return_requests_updated_at           before update on public.return_requests           for each row execute function public.set_updated_at();
create trigger subscriptions_updated_at             before update on public.subscriptions             for each row execute function public.set_updated_at();
create trigger discount_codes_updated_at            before update on public.discount_codes            for each row execute function public.set_updated_at();
create trigger quotes_updated_at                    before update on public.quotes                    for each row execute function public.set_updated_at();
create trigger purchase_orders_updated_at           before update on public.purchase_orders           for each row execute function public.set_updated_at();
create trigger gift_cards_updated_at                before update on public.gift_cards                for each row execute function public.set_updated_at();
create trigger collection_points_updated_at         before update on public.collection_points         for each row execute function public.set_updated_at();
create trigger store_integrations_updated_at        before update on public.store_integrations        for each row execute function public.set_updated_at();
create trigger integration_webhooks_updated_at      before update on public.integration_webhooks      for each row execute function public.set_updated_at();
create trigger metafields_updated_at                before update on public.metafields                for each row execute function public.set_updated_at();
create trigger metafield_definitions_updated_at     before update on public.metafield_definitions     for each row execute function public.set_updated_at();
create trigger product_feed_data_updated_at         before update on public.product_feed_data         for each row execute function public.set_updated_at();
create trigger merchant_feeds_updated_at            before update on public.merchant_feeds            for each row execute function public.set_updated_at();
create trigger store_tracking_pixels_updated_at     before update on public.store_tracking_pixels     for each row execute function public.set_updated_at();
create trigger automatic_discounts_updated_at       before update on public.automatic_discounts       for each row execute function public.set_updated_at();
create trigger abandoned_carts_updated_at           before update on public.abandoned_carts           for each row execute function public.set_updated_at();
create trigger digital_product_files_updated_at     before update on public.digital_product_files     for each row execute function public.set_updated_at();
create trigger product_reviews_updated_at           before update on public.product_reviews           for each row execute function public.set_updated_at();
create trigger wishlists_updated_at                 before update on public.wishlists                 for each row execute function public.set_updated_at();
create trigger fulfillment_orders_updated_at        before update on public.fulfillment_orders        for each row execute function public.set_updated_at();
create trigger fulfillment_order_lines_updated_at   before update on public.fulfillment_order_lines   for each row execute function public.set_updated_at();
create trigger suppliers_updated_at                 before update on public.suppliers                 for each row execute function public.set_updated_at();

-- ============================================================================
-- 22. RETENTION TRIGGERS (opportunistic, 0.1% of inserts)
-- ============================================================================

create or replace function public.payment_provider_webhook_log_retention()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if (random() < 0.001) then
    delete from public.payment_provider_webhook_log
    where created_at < now() - interval '180 days';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_provider_webhook_log_retention on public.payment_provider_webhook_log;
create trigger trg_payment_provider_webhook_log_retention
  after insert on public.payment_provider_webhook_log
  for each row execute function public.payment_provider_webhook_log_retention();

create or replace function public.webhook_delivery_log_retention()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if (random() < 0.001) then
    delete from public.webhook_delivery_log
    where delivered_at < now() - interval '180 days';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_webhook_delivery_log_retention on public.webhook_delivery_log;
create trigger trg_webhook_delivery_log_retention
  after insert on public.webhook_delivery_log
  for each row execute function public.webhook_delivery_log_retention();

commit;
