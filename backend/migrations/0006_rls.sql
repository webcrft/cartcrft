-- ============================================================================
-- 0006_RLS — Row Level Security for all commerce tables
--
-- Ported from webcrft-mono: 20260407000036_commerce_rls.sql
-- Cartcrft adaptations:
--   • is_store_member() reimplemented standalone: no organization_members table.
--     Cartcrft is headless and the application server connects as a superuser/
--     BYPASSRLS role. RLS here is defence-in-depth only.
--     → returns TRUE when app.user_id GUC is non-empty; the app is responsible
--       for authorization before setting this GUC.
--   • Booking-related tables (booking_resources, bookings, …) skipped here;
--     they will get RLS in 0007_booking.sql.
--   • Added new policies for: agents, mandates, agent_audit_log,
--     api_keys, exchange_rates, suppliers.
--   • All website-builder / sites / domains / chat references stripped.
-- ============================================================================

begin;

-- ============================================================================
-- HELPER: is_store_member(p_store_id uuid) → boolean
-- ============================================================================
-- In the standalone cartcrft deployment there is no platform organisation_members
-- table. The application server is expected to:
--   1. Authenticate the incoming request itself.
--   2. Set the GUC app.user_id to the authenticated user's UUID.
--   3. Set app.store_id when operating in a per-store context.
--
-- RLS therefore trusts the presence of a non-empty app.user_id as proof that
-- the connection was set up by an authenticated application request.
-- Service accounts / migrations / cron jobs run as BYPASSRLS and are unaffected.

create or replace function public.is_store_member(p_store_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id text;
begin
  v_user_id := nullif(current_setting('app.user_id', true), '');
  -- No GUC set → deny (protects against accidental unguarded connections)
  if v_user_id is null then
    return false;
  end if;
  -- Verify the requested store exists (prevents RLS bypass via non-existent store UUIDs)
  return exists (
    select 1 from public.stores where id = p_store_id and is_active = true
  );
end;
$$;

comment on function public.is_store_member(uuid) is
  'Returns TRUE when the current connection has set app.user_id (i.e. is an '
  'authenticated application request) and the target store exists and is active. '
  'Standalone replacement for the webcrft organization_members join.';

-- ============================================================================
-- Enable RLS on all commerce tables
-- (Any table listed here that doesn''t exist will cause an error — all must be
--  created by migrations 0001–0005 before this file runs.)
-- ============================================================================

alter table public.stores                          enable row level security;
alter table public.payment_providers               enable row level security;
alter table public.shipping_providers              enable row level security;
alter table public.tax_providers                   enable row level security;
alter table public.notification_providers          enable row level security;
alter table public.tax_categories                  enable row level security;
alter table public.products                        enable row level security;
alter table public.product_options                 enable row level security;
alter table public.product_option_values           enable row level security;
alter table public.product_variants                enable row level security;
alter table public.variant_option_values           enable row level security;
alter table public.product_media                   enable row level security;
alter table public.product_bundle_items            enable row level security;
alter table public.collections                     enable row level security;
alter table public.product_collections             enable row level security;
alter table public.price_lists                     enable row level security;
alter table public.price_list_items                enable row level security;
alter table public.warehouses                      enable row level security;
alter table public.inventory_levels                enable row level security;
alter table public.inventory_lots                  enable row level security;
alter table public.inventory_adjustments           enable row level security;
alter table public.customers                       enable row level security;
alter table public.customer_addresses              enable row level security;
alter table public.companies                       enable row level security;
alter table public.company_customers               enable row level security;
alter table public.customer_groups                 enable row level security;
alter table public.customer_group_members          enable row level security;
alter table public.tax_zones                       enable row level security;
alter table public.tax_zone_regions                enable row level security;
alter table public.tax_rates                       enable row level security;
alter table public.shipping_zones                  enable row level security;
alter table public.shipping_zone_regions           enable row level security;
alter table public.shipping_rates                  enable row level security;
alter table public.collection_points               enable row level security;
alter table public.discount_codes                  enable row level security;
alter table public.discount_usages                 enable row level security;
alter table public.carts                           enable row level security;
alter table public.cart_lines                      enable row level security;
alter table public.checkouts                       enable row level security;
alter table public.orders                          enable row level security;
alter table public.order_lines                     enable row level security;
alter table public.order_adjustments               enable row level security;
alter table public.order_events                    enable row level security;
alter table public.payments                        enable row level security;
alter table public.payment_attempts                enable row level security;
alter table public.refunds                         enable row level security;
alter table public.refund_lines                    enable row level security;
alter table public.store_credits                   enable row level security;
alter table public.store_credit_transactions       enable row level security;
alter table public.shipments                       enable row level security;
alter table public.shipment_lines                  enable row level security;
alter table public.shipment_tracking_events        enable row level security;
alter table public.return_requests                 enable row level security;
alter table public.return_request_lines            enable row level security;
alter table public.return_events                   enable row level security;
alter table public.subscription_plans              enable row level security;
alter table public.subscriptions                   enable row level security;
alter table public.subscription_items              enable row level security;
alter table public.subscription_orders             enable row level security;
alter table public.quotes                          enable row level security;
alter table public.quote_lines                     enable row level security;
alter table public.purchase_orders                 enable row level security;
alter table public.gift_cards                      enable row level security;
alter table public.gift_card_transactions          enable row level security;
alter table public.serial_numbers                  enable row level security;
alter table public.metafields                      enable row level security;
alter table public.metafield_definitions           enable row level security;
alter table public.product_feed_data               enable row level security;
alter table public.product_feed_translations       enable row level security;
alter table public.merchant_feeds                  enable row level security;
alter table public.feed_shipping_overrides         enable row level security;
alter table public.store_integrations              enable row level security;
alter table public.integration_webhooks            enable row level security;
alter table public.integration_sync_logs           enable row level security;
alter table public.store_integration_sync_log      enable row level security;
alter table public.store_integration_oauth_states  enable row level security;
alter table public.store_tracking_pixels           enable row level security;
alter table public.webhook_delivery_log            enable row level security;
alter table public.payment_provider_webhook_log    enable row level security;
alter table public.webhook_replay_guard            enable row level security;
alter table public.automatic_discounts             enable row level security;
alter table public.collection_rules                enable row level security;
alter table public.abandoned_carts                 enable row level security;
alter table public.digital_product_files           enable row level security;
alter table public.digital_download_links          enable row level security;
alter table public.product_reviews                 enable row level security;
alter table public.wishlists                       enable row level security;
alter table public.wishlist_items                  enable row level security;
alter table public.fulfillment_orders              enable row level security;
alter table public.fulfillment_order_lines         enable row level security;
alter table public.product_tags                    enable row level security;
alter table public.customer_tags                   enable row level security;
alter table public.suppliers                       enable row level security;
-- 0003 tables
alter table public.customer_sessions               enable row level security;
alter table public.customer_email_verifications    enable row level security;
alter table public.customer_password_resets        enable row level security;
alter table public.customer_auth_tokens            enable row level security;
alter table public.org_email_providers             enable row level security;
alter table public.org_email_templates             enable row level security;
-- 0004 tables
alter table public.api_keys                        enable row level security;
alter table public.exchange_rates                  enable row level security;
-- 0005 tables
alter table public.agents                          enable row level security;
alter table public.mandates                        enable row level security;
alter table public.agent_audit_log                 enable row level security;
-- Catalogue table (no per-store isolation; superuser manages)
alter table public.integration_definitions         enable row level security;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================
-- Convention:
--   • SELECT / INSERT / UPDATE / DELETE split where read vs write differs.
--   • USING (is_store_member(store_id)) — access gate.
--   • WITH CHECK (is_store_member(store_id)) — write gate.
--   • Append-only tables: INSERT allowed, no UPDATE/DELETE policies.
--   • Shared / catalogue tables: read-all, write-superuser-only.
-- ============================================================================

-- ---- stores ----------------------------------------------------------------
create policy stores_select on public.stores for select
  using (public.is_store_member(id));

create policy stores_insert on public.stores for insert
  with check (nullif(current_setting('app.user_id', true), '') is not null);

create policy stores_update on public.stores for update
  using (public.is_store_member(id))
  with check (public.is_store_member(id));

-- ---- payment_providers -----------------------------------------------------
create policy payment_providers_all on public.payment_providers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- shipping_providers ----------------------------------------------------
create policy shipping_providers_all on public.shipping_providers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- tax_providers ---------------------------------------------------------
create policy tax_providers_all on public.tax_providers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- notification_providers ------------------------------------------------
create policy notification_providers_all on public.notification_providers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- tax_categories --------------------------------------------------------
create policy tax_categories_all on public.tax_categories
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- products --------------------------------------------------------------
create policy products_all on public.products
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- product_options -------------------------------------------------------
create policy product_options_all on public.product_options
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- product_option_values -------------------------------------------------
create policy product_option_values_all on public.product_option_values
  using (exists (
    select 1 from public.product_options po
      join public.products p on p.id = po.product_id
    where po.id = option_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.product_options po
      join public.products p on p.id = po.product_id
    where po.id = option_id and public.is_store_member(p.store_id)
  ));

-- ---- product_variants ------------------------------------------------------
create policy product_variants_all on public.product_variants
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- variant_option_values -------------------------------------------------
create policy variant_option_values_all on public.variant_option_values
  using (exists (
    select 1 from public.product_variants pv
      join public.products p on p.id = pv.product_id
    where pv.id = variant_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.product_variants pv
      join public.products p on p.id = pv.product_id
    where pv.id = variant_id and public.is_store_member(p.store_id)
  ));

-- ---- product_media ---------------------------------------------------------
create policy product_media_all on public.product_media
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- product_bundle_items --------------------------------------------------
create policy product_bundle_items_all on public.product_bundle_items
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- collections -----------------------------------------------------------
create policy collections_all on public.collections
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- product_collections ---------------------------------------------------
create policy product_collections_all on public.product_collections
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- price_lists -----------------------------------------------------------
create policy price_lists_all on public.price_lists
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- price_list_items ------------------------------------------------------
create policy price_list_items_all on public.price_list_items
  using (exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_id and public.is_store_member(pl.store_id)
  ))
  with check (exists (
    select 1 from public.price_lists pl
    where pl.id = price_list_id and public.is_store_member(pl.store_id)
  ));

-- ---- warehouses ------------------------------------------------------------
create policy warehouses_all on public.warehouses
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- inventory_levels ------------------------------------------------------
create policy inventory_levels_all on public.inventory_levels
  using (exists (
    select 1 from public.warehouses w
    where w.id = warehouse_id and public.is_store_member(w.store_id)
  ))
  with check (exists (
    select 1 from public.warehouses w
    where w.id = warehouse_id and public.is_store_member(w.store_id)
  ));

-- ---- inventory_lots --------------------------------------------------------
create policy inventory_lots_all on public.inventory_lots
  using (exists (
    select 1 from public.warehouses w
    where w.id = warehouse_id and public.is_store_member(w.store_id)
  ))
  with check (exists (
    select 1 from public.warehouses w
    where w.id = warehouse_id and public.is_store_member(w.store_id)
  ));

-- ---- inventory_adjustments (append-only) -----------------------------------
create policy inventory_adjustments_select on public.inventory_adjustments for select
  using (exists (
    select 1 from public.warehouses w
    where w.id = warehouse_id and public.is_store_member(w.store_id)
  ));

create policy inventory_adjustments_insert on public.inventory_adjustments for insert
  with check (exists (
    select 1 from public.warehouses w
    where w.id = warehouse_id and public.is_store_member(w.store_id)
  ));

-- ---- customers -------------------------------------------------------------
create policy customers_all on public.customers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- customer_addresses ----------------------------------------------------
create policy customer_addresses_all on public.customer_addresses
  using (exists (
    select 1 from public.customers c
    where c.id = customer_id and public.is_store_member(c.store_id)
  ))
  with check (exists (
    select 1 from public.customers c
    where c.id = customer_id and public.is_store_member(c.store_id)
  ));

-- ---- companies -------------------------------------------------------------
create policy companies_all on public.companies
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- company_customers -----------------------------------------------------
create policy company_customers_all on public.company_customers
  using (exists (
    select 1 from public.companies co
    where co.id = company_id and public.is_store_member(co.store_id)
  ))
  with check (exists (
    select 1 from public.companies co
    where co.id = company_id and public.is_store_member(co.store_id)
  ));

-- ---- customer_groups -------------------------------------------------------
create policy customer_groups_all on public.customer_groups
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- customer_group_members ------------------------------------------------
create policy customer_group_members_all on public.customer_group_members
  using (exists (
    select 1 from public.customer_groups cg
    where cg.id = group_id and public.is_store_member(cg.store_id)
  ))
  with check (exists (
    select 1 from public.customer_groups cg
    where cg.id = group_id and public.is_store_member(cg.store_id)
  ));

-- ---- tax_zones -------------------------------------------------------------
create policy tax_zones_all on public.tax_zones
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- tax_zone_regions ------------------------------------------------------
create policy tax_zone_regions_all on public.tax_zone_regions
  using (exists (
    select 1 from public.tax_zones tz
    where tz.id = zone_id and public.is_store_member(tz.store_id)
  ))
  with check (exists (
    select 1 from public.tax_zones tz
    where tz.id = zone_id and public.is_store_member(tz.store_id)
  ));

-- ---- tax_rates -------------------------------------------------------------
create policy tax_rates_all on public.tax_rates
  using (exists (
    select 1 from public.tax_zones tz
    where tz.id = zone_id and public.is_store_member(tz.store_id)
  ))
  with check (exists (
    select 1 from public.tax_zones tz
    where tz.id = zone_id and public.is_store_member(tz.store_id)
  ));

-- ---- shipping_zones --------------------------------------------------------
create policy shipping_zones_all on public.shipping_zones
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- shipping_zone_regions -------------------------------------------------
create policy shipping_zone_regions_all on public.shipping_zone_regions
  using (exists (
    select 1 from public.shipping_zones sz
    where sz.id = zone_id and public.is_store_member(sz.store_id)
  ))
  with check (exists (
    select 1 from public.shipping_zones sz
    where sz.id = zone_id and public.is_store_member(sz.store_id)
  ));

-- ---- shipping_rates --------------------------------------------------------
create policy shipping_rates_all on public.shipping_rates
  using (exists (
    select 1 from public.shipping_zones sz
    where sz.id = zone_id and public.is_store_member(sz.store_id)
  ))
  with check (exists (
    select 1 from public.shipping_zones sz
    where sz.id = zone_id and public.is_store_member(sz.store_id)
  ));

-- ---- collection_points -----------------------------------------------------
create policy collection_points_all on public.collection_points
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- discount_codes --------------------------------------------------------
create policy discount_codes_all on public.discount_codes
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- discount_usages (append-only) -----------------------------------------
create policy discount_usages_select on public.discount_usages for select
  using (exists (
    select 1 from public.discount_codes dc
    where dc.id = discount_id and public.is_store_member(dc.store_id)
  ));

create policy discount_usages_insert on public.discount_usages for insert
  with check (exists (
    select 1 from public.discount_codes dc
    where dc.id = discount_id and public.is_store_member(dc.store_id)
  ));

-- ---- carts -----------------------------------------------------------------
create policy carts_all on public.carts
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- cart_lines ------------------------------------------------------------
create policy cart_lines_all on public.cart_lines
  using (exists (
    select 1 from public.carts c
    where c.id = cart_id and public.is_store_member(c.store_id)
  ))
  with check (exists (
    select 1 from public.carts c
    where c.id = cart_id and public.is_store_member(c.store_id)
  ));

-- ---- checkouts -------------------------------------------------------------
create policy checkouts_all on public.checkouts
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- orders ----------------------------------------------------------------
create policy orders_all on public.orders
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- order_lines -----------------------------------------------------------
create policy order_lines_all on public.order_lines
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

-- ---- order_adjustments -----------------------------------------------------
create policy order_adjustments_all on public.order_adjustments
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

-- ---- order_events (append-only) --------------------------------------------
create policy order_events_select on public.order_events for select
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

create policy order_events_insert on public.order_events for insert
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

-- ---- payments --------------------------------------------------------------
create policy payments_all on public.payments
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

-- ---- payment_attempts (append-only) ----------------------------------------
create policy payment_attempts_select on public.payment_attempts for select
  using (exists (
    select 1 from public.payments p
      join public.orders o on o.id = p.order_id
    where p.id = payment_id and public.is_store_member(o.store_id)
  ));

create policy payment_attempts_insert on public.payment_attempts for insert
  with check (exists (
    select 1 from public.payments p
      join public.orders o on o.id = p.order_id
    where p.id = payment_id and public.is_store_member(o.store_id)
  ));

-- ---- refunds ---------------------------------------------------------------
create policy refunds_all on public.refunds
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

-- ---- refund_lines ----------------------------------------------------------
create policy refund_lines_all on public.refund_lines
  using (exists (
    select 1 from public.refunds r
      join public.orders o on o.id = r.order_id
    where r.id = refund_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.refunds r
      join public.orders o on o.id = r.order_id
    where r.id = refund_id and public.is_store_member(o.store_id)
  ));

-- ---- store_credits ---------------------------------------------------------
create policy store_credits_all on public.store_credits
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- store_credit_transactions (append-only) --------------------------------
create policy store_credit_transactions_select on public.store_credit_transactions for select
  using (exists (
    select 1 from public.store_credits sc
    where sc.id = store_credit_id and public.is_store_member(sc.store_id)
  ));

create policy store_credit_transactions_insert on public.store_credit_transactions for insert
  with check (exists (
    select 1 from public.store_credits sc
    where sc.id = store_credit_id and public.is_store_member(sc.store_id)
  ));

-- ---- shipments -------------------------------------------------------------
create policy shipments_all on public.shipments
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.orders o
    where o.id = order_id and public.is_store_member(o.store_id)
  ));

-- ---- shipment_lines --------------------------------------------------------
create policy shipment_lines_all on public.shipment_lines
  using (exists (
    select 1 from public.shipments s
      join public.orders o on o.id = s.order_id
    where s.id = shipment_id and public.is_store_member(o.store_id)
  ))
  with check (exists (
    select 1 from public.shipments s
      join public.orders o on o.id = s.order_id
    where s.id = shipment_id and public.is_store_member(o.store_id)
  ));

-- ---- shipment_tracking_events (append-only) ---------------------------------
create policy shipment_tracking_select on public.shipment_tracking_events for select
  using (exists (
    select 1 from public.shipments s
      join public.orders o on o.id = s.order_id
    where s.id = shipment_id and public.is_store_member(o.store_id)
  ));

create policy shipment_tracking_insert on public.shipment_tracking_events for insert
  with check (exists (
    select 1 from public.shipments s
      join public.orders o on o.id = s.order_id
    where s.id = shipment_id and public.is_store_member(o.store_id)
  ));

-- ---- return_requests -------------------------------------------------------
create policy return_requests_all on public.return_requests
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- return_request_lines --------------------------------------------------
create policy return_request_lines_all on public.return_request_lines
  using (exists (
    select 1 from public.return_requests rr
    where rr.id = return_id and public.is_store_member(rr.store_id)
  ))
  with check (exists (
    select 1 from public.return_requests rr
    where rr.id = return_id and public.is_store_member(rr.store_id)
  ));

-- ---- return_events (append-only) -------------------------------------------
create policy return_events_select on public.return_events for select
  using (exists (
    select 1 from public.return_requests rr
    where rr.id = return_id and public.is_store_member(rr.store_id)
  ));

create policy return_events_insert on public.return_events for insert
  with check (exists (
    select 1 from public.return_requests rr
    where rr.id = return_id and public.is_store_member(rr.store_id)
  ));

-- ---- subscription_plans ----------------------------------------------------
create policy subscription_plans_all on public.subscription_plans
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- subscriptions ---------------------------------------------------------
create policy subscriptions_all on public.subscriptions
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- subscription_items ----------------------------------------------------
create policy subscription_items_all on public.subscription_items
  using (exists (
    select 1 from public.subscriptions s
    where s.id = subscription_id and public.is_store_member(s.store_id)
  ))
  with check (exists (
    select 1 from public.subscriptions s
    where s.id = subscription_id and public.is_store_member(s.store_id)
  ));

-- ---- subscription_orders ---------------------------------------------------
create policy subscription_orders_all on public.subscription_orders
  using (exists (
    select 1 from public.subscriptions s
    where s.id = subscription_id and public.is_store_member(s.store_id)
  ))
  with check (exists (
    select 1 from public.subscriptions s
    where s.id = subscription_id and public.is_store_member(s.store_id)
  ));

-- ---- quotes ----------------------------------------------------------------
create policy quotes_all on public.quotes
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- quote_lines -----------------------------------------------------------
create policy quote_lines_all on public.quote_lines
  using (exists (
    select 1 from public.quotes q
    where q.id = quote_id and public.is_store_member(q.store_id)
  ))
  with check (exists (
    select 1 from public.quotes q
    where q.id = quote_id and public.is_store_member(q.store_id)
  ));

-- ---- purchase_orders -------------------------------------------------------
create policy purchase_orders_all on public.purchase_orders
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- gift_cards ------------------------------------------------------------
create policy gift_cards_all on public.gift_cards
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- gift_card_transactions (append-only) ----------------------------------
create policy gift_card_transactions_select on public.gift_card_transactions for select
  using (exists (
    select 1 from public.gift_cards gc
    where gc.id = gift_card_id and public.is_store_member(gc.store_id)
  ));

create policy gift_card_transactions_insert on public.gift_card_transactions for insert
  with check (exists (
    select 1 from public.gift_cards gc
    where gc.id = gift_card_id and public.is_store_member(gc.store_id)
  ));

-- ---- serial_numbers --------------------------------------------------------
create policy serial_numbers_all on public.serial_numbers
  using (exists (
    select 1 from public.product_variants pv
      join public.products p on p.id = pv.product_id
    where pv.id = variant_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.product_variants pv
      join public.products p on p.id = pv.product_id
    where pv.id = variant_id and public.is_store_member(p.store_id)
  ));

-- ---- metafields ------------------------------------------------------------
create policy metafields_all on public.metafields
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- metafield_definitions -------------------------------------------------
create policy metafield_definitions_all on public.metafield_definitions
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- product_feed_data -----------------------------------------------------
create policy product_feed_data_all on public.product_feed_data
  using (exists (
    select 1 from public.product_variants pv
      join public.products p on p.id = pv.product_id
    where pv.id = variant_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.product_variants pv
      join public.products p on p.id = pv.product_id
    where pv.id = variant_id and public.is_store_member(p.store_id)
  ));

-- ---- product_feed_translations ---------------------------------------------
create policy product_feed_translations_all on public.product_feed_translations
  using (exists (
    select 1 from public.product_feed_data pfd
      join public.product_variants pv on pv.id = pfd.variant_id
      join public.products p on p.id = pv.product_id
    where pfd.id = feed_data_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.product_feed_data pfd
      join public.product_variants pv on pv.id = pfd.variant_id
      join public.products p on p.id = pv.product_id
    where pfd.id = feed_data_id and public.is_store_member(p.store_id)
  ));

-- ---- merchant_feeds --------------------------------------------------------
create policy merchant_feeds_all on public.merchant_feeds
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- feed_shipping_overrides -----------------------------------------------
create policy feed_shipping_overrides_all on public.feed_shipping_overrides
  using (exists (
    select 1 from public.merchant_feeds mf
    where mf.id = feed_id and public.is_store_member(mf.store_id)
  ))
  with check (exists (
    select 1 from public.merchant_feeds mf
    where mf.id = feed_id and public.is_store_member(mf.store_id)
  ));

-- ---- store_integrations ----------------------------------------------------
create policy store_integrations_all on public.store_integrations
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- integration_webhooks --------------------------------------------------
create policy integration_webhooks_all on public.integration_webhooks
  using (exists (
    select 1 from public.store_integrations si
    where si.id = store_integration_id and public.is_store_member(si.store_id)
  ))
  with check (exists (
    select 1 from public.store_integrations si
    where si.id = store_integration_id and public.is_store_member(si.store_id)
  ));

-- ---- integration_sync_logs (append-only) ------------------------------------
create policy integration_sync_logs_select on public.integration_sync_logs for select
  using (exists (
    select 1 from public.store_integrations si
    where si.id = store_integration_id and public.is_store_member(si.store_id)
  ));

create policy integration_sync_logs_insert on public.integration_sync_logs for insert
  with check (exists (
    select 1 from public.store_integrations si
    where si.id = store_integration_id and public.is_store_member(si.store_id)
  ));

-- ---- store_integration_sync_log (append-only) --------------------------------
create policy store_integration_sync_log_select on public.store_integration_sync_log for select
  using (exists (
    select 1 from public.store_integrations si
    where si.id = store_integration_id and public.is_store_member(si.store_id)
  ));

create policy store_integration_sync_log_insert on public.store_integration_sync_log for insert
  with check (exists (
    select 1 from public.store_integrations si
    where si.id = store_integration_id and public.is_store_member(si.store_id)
  ));

-- ---- store_integration_oauth_states ----------------------------------------
create policy int_oauth_states_all on public.store_integration_oauth_states
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- store_tracking_pixels -------------------------------------------------
create policy store_tracking_pixels_all on public.store_tracking_pixels
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- webhook_delivery_log --------------------------------------------------
-- Split SELECT/INSERT: reads require member, inserts allowed from authenticated context
create policy webhook_delivery_log_select on public.webhook_delivery_log for select
  using (exists (
    select 1 from public.integration_webhooks wh
      join public.store_integrations si on si.id = wh.store_integration_id
    where wh.id = webhook_id and public.is_store_member(si.store_id)
  ));

create policy webhook_delivery_log_insert on public.webhook_delivery_log for insert
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ---- payment_provider_webhook_log ------------------------------------------
create policy payment_provider_webhook_log_select on public.payment_provider_webhook_log for select
  using (public.is_store_member(store_id));

create policy payment_provider_webhook_log_insert on public.payment_provider_webhook_log for insert
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ---- webhook_replay_guard --------------------------------------------------
-- Purely internal; allow all from authenticated connections
create policy webhook_replay_guard_all on public.webhook_replay_guard
  using  (nullif(current_setting('app.user_id', true), '') is not null)
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ---- automatic_discounts ---------------------------------------------------
create policy automatic_discounts_all on public.automatic_discounts
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- collection_rules ------------------------------------------------------
create policy collection_rules_all on public.collection_rules
  using (exists (
    select 1 from public.collections c
    where c.id = collection_id and public.is_store_member(c.store_id)
  ))
  with check (exists (
    select 1 from public.collections c
    where c.id = collection_id and public.is_store_member(c.store_id)
  ));

-- ---- abandoned_carts -------------------------------------------------------
create policy abandoned_carts_all on public.abandoned_carts
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- digital_product_files -------------------------------------------------
create policy digital_product_files_all on public.digital_product_files
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- digital_download_links ------------------------------------------------
create policy digital_download_links_all on public.digital_download_links
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- product_reviews -------------------------------------------------------
create policy product_reviews_all on public.product_reviews
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- wishlists -------------------------------------------------------------
create policy wishlists_all on public.wishlists
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- wishlist_items --------------------------------------------------------
create policy wishlist_items_all on public.wishlist_items
  using (exists (
    select 1 from public.wishlists w
    where w.id = wishlist_id and public.is_store_member(w.store_id)
  ))
  with check (exists (
    select 1 from public.wishlists w
    where w.id = wishlist_id and public.is_store_member(w.store_id)
  ));

-- ---- fulfillment_orders ----------------------------------------------------
create policy fulfillment_orders_all on public.fulfillment_orders
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- fulfillment_order_lines -----------------------------------------------
create policy fulfillment_order_lines_all on public.fulfillment_order_lines
  using (exists (
    select 1 from public.fulfillment_orders fo
    where fo.id = fulfillment_order_id and public.is_store_member(fo.store_id)
  ))
  with check (exists (
    select 1 from public.fulfillment_orders fo
    where fo.id = fulfillment_order_id and public.is_store_member(fo.store_id)
  ));

-- ---- product_tags ----------------------------------------------------------
create policy product_tags_all on public.product_tags
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- customer_tags ---------------------------------------------------------
create policy customer_tags_all on public.customer_tags
  using (exists (
    select 1 from public.customers c
    where c.id = customer_id and public.is_store_member(c.store_id)
  ))
  with check (exists (
    select 1 from public.customers c
    where c.id = customer_id and public.is_store_member(c.store_id)
  ));

-- ---- suppliers -------------------------------------------------------------
create policy suppliers_all on public.suppliers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ============================================================================
-- 0003 AUTH TABLES
-- ============================================================================

-- ---- customer_sessions (per-store) -----------------------------------------
create policy customer_sessions_all on public.customer_sessions
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- customer_email_verifications ------------------------------------------
create policy customer_email_verifications_all on public.customer_email_verifications
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- customer_password_resets ----------------------------------------------
create policy customer_password_resets_all on public.customer_password_resets
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- customer_auth_tokens --------------------------------------------------
create policy customer_auth_tokens_all on public.customer_auth_tokens
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- org_email_providers (org-scoped, allow authenticated reads) -------------
create policy org_email_providers_all on public.org_email_providers
  using (nullif(current_setting('app.user_id', true), '') is not null)
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ---- org_email_templates (org-scoped) ---------------------------------------
create policy org_email_templates_all on public.org_email_templates
  using (nullif(current_setting('app.user_id', true), '') is not null)
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ============================================================================
-- 0004 PLATFORM TABLES
-- ============================================================================

-- ---- api_keys (org-level; store_id optional scope) -------------------------
create policy api_keys_all on public.api_keys
  using (nullif(current_setting('app.user_id', true), '') is not null)
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ---- exchange_rates (shared read; superuser write) --------------------------
create policy exchange_rates_select on public.exchange_rates for select
  using (nullif(current_setting('app.user_id', true), '') is not null);

-- No INSERT/UPDATE/DELETE policy — only superuser/currency worker (BYPASSRLS) writes.

-- ============================================================================
-- 0005 AGENT TABLES
-- ============================================================================

-- ---- agents ----------------------------------------------------------------
create policy agents_all on public.agents
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- mandates --------------------------------------------------------------
create policy mandates_all on public.mandates
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- agent_audit_log (append-only — no UPDATE/DELETE policies) --------------
create policy agent_audit_log_select on public.agent_audit_log for select
  using (public.is_store_member(store_id));

create policy agent_audit_log_insert on public.agent_audit_log for insert
  with check (public.is_store_member(store_id));

-- ============================================================================
-- CATALOGUE / SHARED TABLES (read-all authenticated, write superuser only)
-- ============================================================================

-- integration_definitions is a shared catalogue (maintained by superuser/migrations)
create policy integration_definitions_select on public.integration_definitions for select
  using (nullif(current_setting('app.user_id', true), '') is not null);

-- No INSERT/UPDATE/DELETE policy on integration_definitions — managed via migrations.

commit;
