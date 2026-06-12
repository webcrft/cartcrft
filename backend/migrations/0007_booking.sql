-- ============================================================================
-- 0007_BOOKING — bookings, OTA channels, iCal sync, and translation tables
--
-- Ported from webcrft-mono: 20260407000034_commerce_booking.sql
-- Cartcrft adaptations:
--   • profiles FKs (reviewer_id, created_by, requested_by, reported_by,
--     initiated_by, reviewed_by, sender_id) replaced with plain uuid nullable
--     (no FK — no platform profiles table in this repo)
--   • organization_id not present in booking tables (org scoping is via store)
--   • next_booking_number() is already defined in 0002_functions.sql; the
--     duplicate definition in the source is omitted
--   • suppliers table already defined in 0001_commerce.sql with richer columns
--     (contact_name, code, payment_terms_days); the source's slimmer version is
--     omitted — the FK order_lines.supplier_id already resolves to 0001's table
--   • order_lines.supplier_id FK already declared in 0001_commerce.sql — omitted
--   • orders.booking_id column already declared in 0001_commerce.sql as a plain
--     uuid nullable; only the FK constraint + index are added here
--   • products.type constraint: 0001 already includes all types through 'rental';
--     'domain' added with DROP/ADD to match source intent
--   • Credential columns (api_key, api_secret, access_token, refresh_token,
--     webhook_secret) kept as TEXT per source — AES-256-GCM ciphertext when
--     AUTH_SECRETS_KEY is set, plaintext in dev (same pattern as payment providers)
--   • Builder/renderer/sites/chat/forms/storage references stripped (none present
--     in this source table set)
--   • All wc_ / webcrft branding already absent in this migration's tables
--   • RLS policies for all new tables added at the end of this file (deferred
--     from 0006 per its header comment)
-- ============================================================================

begin;

-- ============================================================================
-- 1. MULTILINGUAL TRANSLATIONS
--    Locale-specific overrides for text fields on core catalog entities.
--    Falls back to base table fields when no row exists for a locale.
-- ============================================================================

create table public.product_translations (
  id          uuid        primary key default gen_random_uuid(),
  product_id  uuid        not null references public.products(id) on delete cascade,
  locale      text        not null,  -- BCP-47, e.g. 'fr', 'ar', 'zh-CN', 'pt-BR'
  title       text,
  description text,
  seo_title   text,
  seo_desc    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(product_id, locale)
);
comment on table public.product_translations is
  'Locale-specific overrides for product text fields. Falls back to base product fields when no translation exists for a locale.';
create index idx_product_translations_product on public.product_translations(product_id);
create index idx_product_translations_locale  on public.product_translations(locale);

create table public.product_variant_translations (
  id         uuid        primary key default gen_random_uuid(),
  variant_id uuid        not null references public.product_variants(id) on delete cascade,
  locale     text        not null,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(variant_id, locale)
);
create index idx_variant_translations_variant on public.product_variant_translations(variant_id);

create table public.product_option_translations (
  id         uuid        primary key default gen_random_uuid(),
  option_id  uuid        not null references public.product_options(id) on delete cascade,
  locale     text        not null,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(option_id, locale)
);
create index idx_option_translations_option on public.product_option_translations(option_id);

create table public.product_option_value_translations (
  id              uuid        primary key default gen_random_uuid(),
  option_value_id uuid        not null references public.product_option_values(id) on delete cascade,
  locale          text        not null,
  value           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(option_value_id, locale)
);
create index idx_option_value_translations_value on public.product_option_value_translations(option_value_id);

create table public.collection_translations (
  id            uuid        primary key default gen_random_uuid(),
  collection_id uuid        not null references public.collections(id) on delete cascade,
  locale        text        not null,
  title         text,
  description   text,
  seo_title     text,
  seo_desc      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique(collection_id, locale)
);
create index idx_collection_translations_collection on public.collection_translations(collection_id);

create table public.store_translations (
  id         uuid        primary key default gen_random_uuid(),
  store_id   uuid        not null references public.stores(id) on delete cascade,
  locale     text        not null,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, locale)
);
create index idx_store_translations_store on public.store_translations(store_id);

-- ============================================================================
-- 2. CANCELLATION POLICIES
--    Reusable policies referenced by booking resources and individual bookings.
--    rules is an ordered array: [{hours_before: 48, refund_pct: 100}, ...]
-- ============================================================================

create table public.cancellation_policies (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id) on delete cascade,
  name        text        not null,
  type        text        not null default 'moderate'
                check (type in (
                  'flexible',       -- full refund up to 24h before
                  'moderate',       -- full refund up to 5 days before
                  'strict',         -- 50% refund up to 1 week before
                  'super_strict',   -- 50% refund up to 30 days before
                  'non_refundable', -- no refund
                  'custom'          -- use rules array
                )),
  -- ordered thresholds: [{hours_before: 48, refund_pct: 100}, {hours_before: 0, refund_pct: 0}]
  rules       jsonb       not null default '[]',
  description text,
  is_default  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.cancellation_policies is
  'Store-level cancellation policies. rules is an ordered array of {hours_before, refund_pct} thresholds applied in sequence at cancellation time.';
create index idx_cancellation_policies_store on public.cancellation_policies(store_id);

create table public.cancellation_policy_translations (
  id          uuid        primary key default gen_random_uuid(),
  policy_id   uuid        not null references public.cancellation_policies(id) on delete cascade,
  locale      text        not null,
  name        text,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(policy_id, locale)
);
create index idx_cp_translations_policy on public.cancellation_policy_translations(policy_id);

-- ============================================================================
-- 3. BOOKING RESOURCES
--    The physical or virtual asset being booked.
--    parent_id supports property hierarchies: hotel → rooms.
-- ============================================================================

create table public.booking_resources (
  id                     uuid          primary key default gen_random_uuid(),
  store_id               uuid          not null references public.stores(id) on delete cascade,
  product_id             uuid          references public.products(id) on delete set null,
  name                   text          not null,
  type                   text          not null default 'accommodation'
                           check (type in (
                             'accommodation',  -- hotel, B&B, guesthouse
                             'room',           -- room within a property
                             'property',       -- entire home/apartment
                             'vehicle',        -- car, boat, campervan
                             'experience',     -- tour, activity, class
                             'desk',           -- coworking hot-desk
                             'equipment',      -- camera, gear, tools
                             'event_space'     -- conference room, venue
                           )),
  parent_id              uuid          references public.booking_resources(id) on delete set null,
  capacity               int           not null default 1 check (capacity > 0),
  -- booking time unit
  time_unit              text          not null default 'nightly'
                           check (time_unit in ('nightly','daily','hourly')),
  min_duration           int           not null default 1,  -- in time_unit units
  max_duration           int,                               -- null = unlimited
  check_in_time          time,                              -- e.g. 15:00:00
  check_out_time         time,                              -- e.g. 11:00:00
  buffer_hours           int           not null default 0,  -- prep/cleaning gap between bookings
  timezone               text          not null default 'UTC',
  -- pricing
  base_price             numeric(15,2) not null,            -- per time_unit in store currency
  weekend_price          numeric(15,2),                     -- override for Fri/Sat nights
  cleaning_fee           numeric(15,2),
  extra_guest_fee        numeric(15,2),                     -- per guest above base_capacity
  base_capacity          int           not null default 1,  -- guests included in base_price
  security_deposit       numeric(15,2),
  -- policies
  cancellation_policy_id uuid          references public.cancellation_policies(id) on delete set null,
  instant_bookable       boolean       not null default false,  -- no host approval required
  -- location
  address                jsonb,   -- {line1, city, province, country_code, postal_code}
  coordinates            jsonb,   -- {lat, lng}
  -- attributes
  amenities              text[]        not null default '{}',
  rules                  jsonb         not null default '{}',  -- {pets_allowed, smoking_allowed, ...}
  is_active              boolean       not null default true,
  metadata               jsonb         not null default '{}',
  deleted_at             timestamptz,
  created_at             timestamptz   not null default now(),
  updated_at             timestamptz   not null default now()
);
comment on table public.booking_resources is
  'A bookable resource (room, property, vehicle, experience). Linked to a product for storefront display. parent_id supports hierarchical properties (hotel → rooms).';
create index idx_booking_resources_store   on public.booking_resources(store_id);
create index idx_booking_resources_product on public.booking_resources(product_id) where product_id is not null;
create index idx_booking_resources_parent  on public.booking_resources(parent_id)  where parent_id is not null;
create index idx_booking_resources_active  on public.booking_resources(store_id, is_active);
create index idx_booking_resources_parent_active
  on public.booking_resources(parent_id, is_active)
  where parent_id is not null;

create table public.booking_resource_translations (
  id               uuid        primary key default gen_random_uuid(),
  resource_id      uuid        not null references public.booking_resources(id) on delete cascade,
  locale           text        not null,
  name             text,
  description      text,
  rules_text       text,   -- human-readable house rules in this language
  amenities_labels jsonb,  -- {wifi: 'Wi-Fi gratuit', pool: 'Piscine privée'}
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique(resource_id, locale)
);
create index idx_br_translations_resource on public.booking_resource_translations(resource_id);

-- ============================================================================
-- 4. BOOKING AVAILABILITY CALENDAR
--    One row per resource+date. Missing rows = available at base price.
--    Populated by iCal imports, OTA sync, and manual blocks.
-- ============================================================================

create table public.booking_availability (
  id           uuid          primary key default gen_random_uuid(),
  resource_id  uuid          not null references public.booking_resources(id) on delete cascade,
  date         date          not null,
  is_available boolean       not null default true,
  custom_price numeric(15,2),  -- null = use resource base_price + price rules
  min_duration int,            -- per-date minimum stay override (null = use resource default)
  notes        text,           -- internal note: 'maintenance', 'owner stay', 'ical block'
  source       text          not null default 'manual'
                 check (source in ('manual','ical','api','channel')),
  unique(resource_id, date)
);
comment on table public.booking_availability is
  'Per-date availability calendar. Rows with is_available=false block the date. custom_price overrides pricing rules. Populated by iCal imports, OTA sync, or manual blocks.';
create index idx_booking_availability_resource on public.booking_availability(resource_id);
create index idx_booking_availability_range    on public.booking_availability(resource_id, date);
create index idx_booking_availability_date     on public.booking_availability(date);
create index idx_booking_availability_source
  on public.booking_availability(resource_id, source)
  where source is not null;

-- ============================================================================
-- 5. BOOKING PRICE RULES
--    Layered pricing on top of base_price: seasonal, weekend, LOS discounts.
--    At booking time the highest-priority matching rule wins.
-- ============================================================================

create table public.booking_price_rules (
  id               uuid          primary key default gen_random_uuid(),
  resource_id      uuid          not null references public.booking_resources(id) on delete cascade,
  name             text          not null,
  type             text          not null
                     check (type in (
                       'weekend',           -- applies on Fri/Sat nights
                       'seasonal',          -- applies within a date range
                       'last_minute',       -- booked N days before check-in
                       'early_bird',        -- booked N+ days in advance
                       'length_of_stay',    -- discount for staying longer
                       'occupancy_based',   -- surcharge when occupancy >= min_occupancy_pct
                       'custom'
                     )),
  min_occupancy_pct int,          -- for occupancy_based: apply when occupancy% >= this value
  -- date range (null = no bound)
  starts_at        date,
  ends_at          date,
  -- day-of-week mask (null = all days). 0=Sunday, 6=Saturday
  days_of_week     int[],
  -- for last_minute / early_bird
  days_before_min  int,
  days_before_max  int,
  -- minimum stay to qualify for this rule
  min_duration     int,
  -- adjustment
  adjustment_type  text          not null default 'percentage'
                     check (adjustment_type in ('percentage','fixed')),
  -- positive = surcharge, negative = discount
  adjustment_value numeric(15,4) not null,
  priority         int           not null default 0,  -- higher wins when multiple rules match
  is_active        boolean       not null default true,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  -- date range must be ordered when both bounds are set
  check (starts_at is null or ends_at is null or starts_at < ends_at),
  -- percentage: -100 (full discount) to 500 (5x surcharge); fixed: any reasonable amount
  check (
    (adjustment_type = 'percentage' and adjustment_value between -100 and 500) or
    (adjustment_type = 'fixed'      and adjustment_value between -99999.99 and 99999.99)
  )
);
comment on table public.booking_price_rules is
  'Layered pricing rules per resource. At booking-creation time all active matching rules are evaluated; the highest-priority one is applied on top of base_price.';
create index idx_booking_price_rules_resource on public.booking_price_rules(resource_id);
create index idx_booking_price_rules_active   on public.booking_price_rules(resource_id, is_active);
create index idx_booking_price_rules_resource_active
  on public.booking_price_rules(resource_id)
  where is_active = true;

-- ============================================================================
-- 6. BOOKING CHANNEL PROVIDERS (store-level OTA API credentials)
--    One row per OTA per store. Credentials are used to push rates/
--    availability and authenticate inbound reservation webhooks.
--    Must be defined before booking_channel_listings which references it.
-- ============================================================================

create table public.booking_channel_providers (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id) on delete cascade,
  -- provider_type distinguishes direct OTA connections from channel managers
  -- (Guesty, Hostaway, SiteMinder, etc.) that manage multiple OTAs internally.
  provider_type    text        not null default 'direct_ota'
                     check (provider_type in ('direct_ota','channel_manager')),
  channel          text        not null
                     check (channel in (
                       -- Direct OTA connections
                       'airbnb','booking_com','expedia','vrbo',
                       'hotels_com','tripadvisor',
                       'google_vacation_rentals','google_reserve',
                       -- Channel managers (middleware)
                       'guesty','hostaway','siteminder','cloudbeds',
                       'beds24','smoobu','rentals_united','lodgify',
                       'apaleo','mews','little_hotelier','igms',
                       'tokeet','hostfully','ownerrez','escapia',
                       'liveret','kigo','avantio','d_edge'
                     )),
  name             text        not null,
  -- credentials: AES-256-GCM ciphertext (base64 TEXT) when AUTH_SECRETS_KEY
  -- is set, else plaintext (dev only). Decrypted via AUTH_SECRETS_KEY.
  api_key          text,
  api_secret       text,
  webhook_secret   text,
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  push_rates        boolean     not null default true,
  push_availability boolean     not null default true,
  status           text        not null default 'active'
                     check (status in ('active','error','disconnected','pending_auth')),
  config           jsonb       not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- allows both a direct Airbnb connection AND a channel manager (e.g. Guesty) for the same OTA
  unique(store_id, channel, provider_type)
);
comment on table public.booking_channel_providers is
  'OTA API credentials at the store level. Credentials are used for pushing rates/availability to each channel and for authenticating inbound reservation webhooks.';
comment on column public.booking_channel_providers.api_key is
  'AES-256-GCM ciphertext (base64) of the channel-manager API key.';
comment on column public.booking_channel_providers.api_secret is
  'AES-256-GCM ciphertext (base64) of the channel-manager API secret.';
comment on column public.booking_channel_providers.access_token is
  'AES-256-GCM ciphertext (base64) of the OAuth access token.';
comment on column public.booking_channel_providers.refresh_token is
  'AES-256-GCM ciphertext (base64) of the OAuth refresh token.';
comment on column public.booking_channel_providers.webhook_secret is
  'AES-256-GCM ciphertext (base64) of the OTA inbound webhook shared secret. '
  'Decrypted with AUTH_SECRETS_KEY. Never store plaintext here.';
create index idx_booking_channel_providers_store on public.booking_channel_providers(store_id);

-- ============================================================================
-- 7. OTA CHANNEL LISTINGS
--    Defined before bookings so channel_listing_id FK can be inline.
-- ============================================================================

create table public.booking_channel_listings (
  id                     uuid        primary key default gen_random_uuid(),
  resource_id            uuid        not null references public.booking_resources(id) on delete cascade,
  channel                text        not null
                           check (channel in (
                             'airbnb','booking_com','expedia','vrbo',
                             'hotels_com','tripadvisor',
                             'google_vacation_rentals','google_reserve'
                           )),
  channel_listing_id     text,       -- OTA's listing ID
  channel_property_id    text,       -- OTA's property grouping ID (Booking.com property ID)
  sync_rates             boolean     not null default true,
  sync_availability      boolean     not null default true,
  sync_restrictions      boolean     not null default true,
  markup_pct             numeric(7,4),               -- add N% to rates pushed to this channel
  status                 text        not null default 'active'
                           check (status in ('active','paused','error','disconnected')),
  last_pushed_at         timestamptz,
  last_pulled_at         timestamptz,
  error_message          text,
  -- when set, this listing is managed via a channel manager rather than a direct OTA connection
  managed_by_provider_id uuid        references public.booking_channel_providers(id) on delete set null,
  metadata               jsonb       not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique(resource_id, channel)
);
comment on table public.booking_channel_listings is
  'OTA channel distribution for a booking resource. Tracks sync state per channel. markup_pct allows channel-specific rate adjustments (e.g. to cover OTA commission).';
create index idx_channel_listings_resource   on public.booking_channel_listings(resource_id);
create index idx_channel_listings_channel    on public.booking_channel_listings(channel);
create index idx_channel_listings_managed_by on public.booking_channel_listings(managed_by_provider_id)
  where managed_by_provider_id is not null;

-- ============================================================================
-- 8. BOOKINGS (reservations)
--    Always backed by an order (order_id) so payments/refunds reuse the
--    existing payment, refund, and wallet flows unchanged.
-- ============================================================================

create table public.bookings (
  id                     uuid          primary key default gen_random_uuid(),
  store_id               uuid          not null references public.stores(id) on delete cascade,
  resource_id            uuid          not null references public.booking_resources(id) on delete restrict,
  customer_id            uuid          references public.customers(id) on delete set null,
  order_id               uuid          references public.orders(id) on delete restrict,
  booking_number         text          not null,  -- human-readable: B-1042, unique per store
  -- dates
  check_in               date          not null,
  check_out              date          not null,
  check_in_time          time,                    -- null = use resource default
  check_out_time         time,
  -- guests
  num_guests             int           not null default 1 check (num_guests > 0),
  -- override guest contact when different from customer
  guest_name             text,
  guest_email            text,
  guest_phone            text,
  -- status lifecycle
  status                 text          not null default 'pending'
                           check (status in (
                             'inquiry',    -- initial request, not confirmed
                             'pending',    -- awaiting payment
                             'confirmed',  -- paid and confirmed
                             'checked_in',
                             'checked_out',
                             'cancelled',
                             'no_show'
                           )),
  -- pricing snapshot at time of booking (immutable after confirmation)
  nightly_rate           numeric(15,2),
  cleaning_fee           numeric(15,2),
  extra_guest_fee        numeric(15,2),
  security_deposit       numeric(15,2),
  total_nights           int,
  subtotal               numeric(15,2),
  total                  numeric(15,2),
  currency               char(3),
  -- channel attribution
  source_channel         text          not null default 'direct'
                           check (source_channel in (
                             'direct','airbnb','booking_com','expedia','vrbo',
                             'hotels_com','tripadvisor',
                             'google','google_vacation_rentals','google_reserve',
                             'api','pos'
                           )),
  channel_reservation_id text,         -- OTA's own reservation ID
  channel_listing_id     uuid          references public.booking_channel_listings(id) on delete set null,
  -- policies (snapshotted at booking time)
  cancellation_policy_id uuid          references public.cancellation_policies(id) on delete set null,
  -- guest communications
  special_requests       text,
  arrival_instructions   text,
  internal_notes         text,
  -- tax snapshot
  tax_lines              jsonb,         -- [{ name, rate_pct, amount }]
  tax_amount             numeric(15,2)  not null default 0,
  -- lifecycle timestamps
  confirmed_at           timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  deleted_at             timestamptz,
  metadata               jsonb         not null default '{}',
  created_at             timestamptz   not null default now(),
  updated_at             timestamptz   not null default now(),
  unique(store_id, booking_number),
  check (check_out > check_in)
);
comment on table public.bookings is
  'A reservation. order_id links to the orders table so all payments, refunds, and wallet flows are reused. source_channel tracks OTA vs direct. channel_reservation_id is the OTA native ID for 2-way sync.';
create index idx_bookings_store            on public.bookings(store_id);
create index idx_bookings_resource         on public.bookings(resource_id);
create index idx_bookings_customer         on public.bookings(customer_id)            where customer_id is not null;
create index idx_bookings_order            on public.bookings(order_id)               where order_id is not null;
create index idx_bookings_status           on public.bookings(store_id, status);
create index idx_bookings_dates            on public.bookings(resource_id, check_in, check_out);
create index idx_bookings_channel_id       on public.bookings(channel_reservation_id) where channel_reservation_id is not null;
create index idx_bookings_channel_listing  on public.bookings(channel_listing_id)     where channel_listing_id is not null;
-- human-readable lookup within a store (covers the unique constraint but explicit for clarity)
create unique index idx_bookings_store_number on public.bookings(store_id, booking_number);

-- ============================================================================
-- 9. BOOKING REVIEWS
--    Bidirectional: guest reviews the resource; host reviews the guest.
--    reviewee_type determines the direction.
--    reviewer_id: plain uuid nullable (no FK — no platform profiles table)
-- ============================================================================

create table public.booking_reviews (
  id             uuid        primary key default gen_random_uuid(),
  booking_id     uuid        not null references public.bookings(id) on delete cascade,
  reviewer_id    uuid,       -- plain uuid; no FK (no platform profiles table)
  reviewee_type  text        not null check (reviewee_type in ('resource','guest')),
  -- ratings 1-5
  overall_rating int         not null check (overall_rating between 1 and 5),
  cleanliness    int         check (cleanliness    between 1 and 5),
  accuracy       int         check (accuracy       between 1 and 5),
  communication  int         check (communication  between 1 and 5),
  location       int         check (location       between 1 and 5),
  value          int         check (value          between 1 and 5),
  body           text,
  is_public      boolean     not null default true,
  response       text,       -- host's public response to a guest review
  responded_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.booking_reviews is
  'Bidirectional reviews: guests review resources, hosts review guests. reviewee_type distinguishes direction. response allows the host to reply publicly.';
create index idx_booking_reviews_booking  on public.booking_reviews(booking_id);
create index idx_booking_reviews_type     on public.booking_reviews(booking_id, reviewee_type);
create index idx_booking_reviews_public
  on public.booking_reviews(booking_id, is_public, reviewee_type);

-- ============================================================================
-- 10. ICAL FEEDS
--     Import: pull a remote OTA iCal URL to block our availability calendar.
--     Export: expose our calendar as an iCal URL for OTAs to subscribe to.
-- ============================================================================

create table public.ical_feeds (
  id                    uuid        primary key default gen_random_uuid(),
  resource_id           uuid        not null references public.booking_resources(id) on delete cascade,
  channel               text        not null
                          check (channel in (
                            'airbnb','booking_com','vrbo','expedia',
                            'hotels_com','tripadvisor',
                            'google_calendar','google_vacation_rentals','google_reserve',
                            'custom'
                          )),
  direction             text        not null check (direction in ('import','export')),
  url                   text,       -- import: remote iCal URL; export: our generated URL
  sync_interval_minutes int         not null default 60,
  last_synced_at        timestamptz,
  last_error            text,
  is_active             boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- import feeds must have a URL to pull from; export URLs are generated so may start null
  check (direction = 'export' or url is not null),
  -- prevent SSRF: only allow http(s) scheme on import URLs
  check (url is null or direction = 'export' or (url like 'http://%' or url like 'https://%'))
);
comment on table public.ical_feeds is
  'iCal feed configuration per resource per channel. import rows pull remote bookings and block availability. export rows expose our calendar for OTA subscription.';
create index idx_ical_feeds_resource        on public.ical_feeds(resource_id);
create index idx_ical_feeds_sync            on public.ical_feeds(is_active, last_synced_at) where is_active = true;
create index idx_ical_feeds_active_direction on public.ical_feeds(is_active, direction);

-- ============================================================================
-- 11. ICAL SYNC RUNS
--    One row per execution of a feed sync job. Records how many events were
--    processed and any errors, so operators can diagnose stale calendars.
-- ============================================================================

create table public.ical_sync_runs (
  id              uuid        primary key default gen_random_uuid(),
  feed_id         uuid        not null references public.ical_feeds(id) on delete cascade,
  status          text        not null default 'running'
                    check (status in ('running','success','partial','failed')),
  events_imported int         not null default 0,  -- VEVENT rows parsed from remote
  dates_blocked   int         not null default 0,  -- availability rows set is_available=false
  dates_unblocked int         not null default 0,  -- previously blocked rows cleared
  dates_exported  int         not null default 0,  -- dates included in export feed
  error           text,
  http_status     int,                              -- remote server response code (import)
  bytes_fetched   int,                              -- raw response size (import)
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  duration_ms     bigint
                    generated always as (
                      extract(epoch from (finished_at - started_at)) * 1000
                    ) stored
);
comment on table public.ical_sync_runs is
  'Per-execution log for iCal feed syncs. Tracks parse counts, HTTP details, and errors for debugging stale calendars.';
create index idx_ical_sync_runs_feed   on public.ical_sync_runs(feed_id, started_at desc);
create index idx_ical_sync_runs_status on public.ical_sync_runs(status) where status in ('running','failed');

-- ============================================================================
-- 12. BOOKING EVENTS (audit trail, mirrors order_events)
--     Append-only log of every status change, OTA sync event, note, etc.
--     created_by: plain uuid nullable (no FK — no platform profiles table)
-- ============================================================================

create table public.booking_events (
  id         uuid        primary key default gen_random_uuid(),
  booking_id uuid        not null references public.bookings(id) on delete cascade,
  type       text        not null
               check (type in (
                 'status_changed','payment_received','payment_failed',
                 'channel_synced','note_added','cancellation_requested',
                 'ical_imported','check_in','check_out',
                 'modification_requested','modification_approved','modification_rejected',
                 'message_sent','review_requested','review_received',
                 'oauth_completed','webhook_received'
               )),
  data       jsonb       not null default '{}',
  created_by uuid,       -- plain uuid; no FK (no platform profiles table)
  created_at timestamptz not null default now()
);
comment on table public.booking_events is
  'Append-only booking timeline. Every status change, OTA sync, payment event, and note is logged here — mirrors order_events.';
create index idx_booking_events_booking on public.booking_events(booking_id, created_at);
create index idx_booking_events_type    on public.booking_events(booking_id, type, created_at);

-- ============================================================================
-- 13. BOOKING LINE ITEMS
--     Supports composite bookings: main resource + add-ons (breakfast, airport
--     transfer, equipment hire, extra bed). Each line has its own pricing.
--     Required for split-resource bookings (e.g. 2 rooms under one reservation).
-- ============================================================================

create table public.booking_line_items (
  id             uuid          primary key default gen_random_uuid(),
  booking_id     uuid          not null references public.bookings(id) on delete cascade,
  resource_id    uuid          references public.booking_resources(id) on delete restrict,
  variant_id     uuid          references public.product_variants(id) on delete set null,
  -- one of resource_id or variant_id should be set; variant covers product add-ons
  title          text          not null,  -- snapshotted name at booking time
  line_type      text          not null default 'resource'
                   check (line_type in (
                     'resource',   -- a bookable resource (room, vehicle, etc.)
                     'fee',        -- cleaning fee, security deposit, etc.
                     'add_on',     -- product/service add-on (breakfast, parking)
                     'discount',   -- line-level discount
                     'tax'         -- tax line
                   )),
  quantity       int           not null default 1 check (quantity > 0),
  unit_price     numeric(15,2) not null,
  total          numeric(15,2) not null,
  currency       char(3)       not null,
  -- date range for this line (may differ from booking dates for add-ons)
  line_check_in  date,
  line_check_out date,
  metadata       jsonb         not null default '{}',
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  check (line_check_out is null or line_check_in is null or line_check_out > line_check_in)
);
comment on table public.booking_line_items is
  'Line items for a booking: main resource, fees (cleaning, security deposit), product add-ons (breakfast, parking), tax, and discounts. Mirrors order_lines structure.';
create index idx_booking_lines_booking  on public.booking_line_items(booking_id);
create index idx_booking_lines_resource on public.booking_line_items(resource_id) where resource_id is not null;

-- ============================================================================
-- 14. BOOKING MODIFICATIONS
--     Audit trail of date / guest / rate changes after confirmation.
--     Original values are snapshotted so change history is preserved.
--     requested_by / reviewed_by: plain uuid nullable (no profiles FK)
-- ============================================================================

create table public.booking_modifications (
  id              uuid          primary key default gen_random_uuid(),
  booking_id      uuid          not null references public.bookings(id) on delete cascade,
  requested_by    uuid,         -- plain uuid; no FK (no platform profiles table)
  -- what changed
  old_check_in    date,
  new_check_in    date,
  old_check_out   date,
  new_check_out   date,
  old_num_guests  int,
  new_num_guests  int,
  old_total       numeric(15,2),
  new_total       numeric(15,2),
  old_resource_id uuid          references public.booking_resources(id) on delete set null,
  new_resource_id uuid          references public.booking_resources(id) on delete set null,
  status          text          not null default 'pending'
                    check (status in ('pending','approved','rejected','auto_approved')),
  notes           text          check (notes is null or length(notes) <= 2000),
  reviewed_by     uuid,         -- plain uuid; no FK (no platform profiles table)
  reviewed_at     timestamptz,
  created_at      timestamptz   not null default now(),
  check (
    old_check_in is not null or new_check_in is not null or
    old_check_out is not null or new_check_out is not null or
    old_resource_id is not null or new_resource_id is not null
  )
);
comment on table public.booking_modifications is
  'Modification requests on confirmed bookings. Tracks date/guest/rate changes. Requires host approval unless auto-approved by policy.';
create index idx_booking_modifications_booking on public.booking_modifications(booking_id, created_at);

-- ============================================================================
-- 15. BOOKING MESSAGES
--     Guest ↔ host messaging thread per booking.
--     sender_id: plain uuid nullable (no profiles FK)
-- ============================================================================

create table public.booking_messages (
  id          uuid        primary key default gen_random_uuid(),
  booking_id  uuid        not null references public.bookings(id) on delete cascade,
  sender_id   uuid,       -- plain uuid; no FK (no platform profiles table)
  sender_role text        not null default 'guest' check (sender_role in ('guest','host','system')),
  body        text        not null check (length(body) <= 5000),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
comment on table public.booking_messages is
  'Guest-host messaging thread per booking. sender_role=system for automated notifications (check-in reminders, etc.).';
create index idx_booking_messages_booking on public.booking_messages(booking_id, created_at);

-- ============================================================================
-- 16. CHECK-IN TOKENS
--     One-time tokens for contactless / self check-in flows.
--     Generated on confirmation, valid from check_in date until expiry.
-- ============================================================================

create table public.check_in_tokens (
  id          uuid        primary key default gen_random_uuid(),
  booking_id  uuid        not null references public.bookings(id) on delete cascade,
  token       text        not null unique default encode(gen_random_bytes(24), 'hex'),
  -- access scope
  access_type text        not null default 'check_in'
                check (access_type in ('check_in','check_out','full_stay')),
  valid_from  timestamptz not null,
  valid_until timestamptz not null,
  used_at     timestamptz,
  metadata    jsonb       not null default '{}',
  created_at  timestamptz not null default now()
);
comment on table public.check_in_tokens is
  'Contactless check-in tokens. Embedded in QR codes sent to guests. Used once then marked used_at.';
create index idx_check_in_tokens_booking on public.check_in_tokens(booking_id);
create index idx_check_in_tokens_token   on public.check_in_tokens(token);

-- ============================================================================
-- 17. DAMAGE CLAIMS
--     Security deposit dispute tracking for accommodation bookings.
--     reported_by: plain uuid nullable (no profiles FK)
-- ============================================================================

create table public.damage_claims (
  id               uuid          primary key default gen_random_uuid(),
  booking_id       uuid          not null references public.bookings(id) on delete cascade,
  reported_by      uuid,         -- plain uuid; no FK (no platform profiles table)
  description      text          not null,
  claim_amount     numeric(15,2) not null,
  status           text          not null default 'open'
                     check (status in (
                       'open','evidence_requested','disputed','approved','rejected','paid'
                     )),
  evidence         jsonb         not null default '{}',  -- [{url, type, description}]
  resolution_notes text,
  resolved_at      timestamptz,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);
comment on table public.damage_claims is
  'Security deposit damage claims. evidence holds photo/video URLs. claim_amount can be charged against the security deposit held.';
create index idx_damage_claims_booking on public.damage_claims(booking_id);
create index idx_damage_claims_status  on public.damage_claims(status) where status = 'open';

create trigger damage_claims_updated_at
  before update on public.damage_claims
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 18. BOOKING CHANNEL OAUTH STATES
--    Transient PKCE / state parameters for Airbnb and Google OAuth2 flows.
--    Rows expire in 15 minutes and are purged after use.
--    initiated_by: plain uuid nullable (no profiles FK)
-- ============================================================================

create table public.booking_channel_oauth_states (
  id            uuid        primary key default gen_random_uuid(),
  store_id      uuid        not null references public.stores(id) on delete cascade,
  channel       text        not null
                  check (channel in (
                    'airbnb','booking_com','expedia','vrbo',
                    'hotels_com','tripadvisor',
                    'google_vacation_rentals','google_reserve'
                  )),
  state         text        not null unique default encode(gen_random_bytes(24), 'hex'),
  code_verifier text,       -- PKCE S256 code verifier (null for non-PKCE flows)
  redirect_uri  text        not null,
  initiated_by  uuid,       -- plain uuid; no FK (no platform profiles table)
  expires_at    timestamptz not null default (now() + interval '15 minutes'),
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
comment on table public.booking_channel_oauth_states is
  'Transient OAuth2 PKCE state for Airbnb and Google channel connections. Rows expire after 15 minutes; used_at set when code is exchanged.';
create index idx_booking_oauth_store   on public.booking_channel_oauth_states(store_id);
create index idx_booking_oauth_expires on public.booking_channel_oauth_states(expires_at) where used_at is null;

create or replace function public.purge_expired_booking_oauth_states()
returns int
language plpgsql
set search_path = pg_catalog, public
as $$
declare deleted int;
begin
  delete from public.booking_channel_oauth_states
   where expires_at < now() or used_at is not null;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
comment on function public.purge_expired_booking_oauth_states() is
  'Deletes expired and used booking channel OAuth state rows. Safe to call from a background worker at any interval.';

-- ============================================================================
-- 19. BOOKING CHANNEL SYNC JOBS
--    Push queue for rate, availability, and restriction updates sent to OTAs.
-- ============================================================================

create table public.booking_channel_sync_jobs (
  id                 uuid        primary key default gen_random_uuid(),
  store_id           uuid        not null references public.stores(id) on delete cascade,
  channel_listing_id uuid        references public.booking_channel_listings(id) on delete cascade,
  provider_id        uuid        references public.booking_channel_providers(id) on delete cascade,
  channel            text        not null
                       check (channel in (
                         'airbnb','booking_com','expedia','vrbo',
                         'hotels_com','tripadvisor',
                         'google_vacation_rentals','google_reserve'
                       )),
  job_type           text        not null
                       check (job_type in (
                         'push_availability',   -- send blocked/open dates to OTA
                         'push_rates',          -- push pricing (base + rules)
                         'push_restrictions',   -- min stay, closed to arrival/departure
                         'push_listing',        -- full listing content sync
                         'pull_reservations',   -- fetch new reservations from OTA
                         'pull_rates',          -- fetch rates OTA is showing
                         'full_refresh'         -- availability + rates + restrictions
                       )),
  window_start       date,
  window_end         date,
  status             text        not null default 'pending'
                       check (status in ('pending','running','success','failed','cancelled')),
  priority           int         not null default 0,
  attempts           int         not null default 0,
  max_attempts       int         not null default 3,
  scheduled_at       timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  next_retry_at      timestamptz,
  error              text,
  payload            jsonb       not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (window_end is null or window_start is null or window_end >= window_start),
  check (channel_listing_id is not null or provider_id is not null)
);
comment on table public.booking_channel_sync_jobs is
  'Push/pull job queue for OTA channel sync. Workers poll pending jobs and retry on failure up to max_attempts.';
create index idx_sync_jobs_pending on public.booking_channel_sync_jobs(scheduled_at, priority desc)
  where status = 'pending';
create index idx_sync_jobs_store   on public.booking_channel_sync_jobs(store_id, status);
create index idx_sync_jobs_listing on public.booking_channel_sync_jobs(channel_listing_id)
  where channel_listing_id is not null;
create index idx_sync_jobs_retry   on public.booking_channel_sync_jobs(next_retry_at)
  where status = 'failed' and attempts < max_attempts;

create trigger booking_channel_sync_jobs_updated_at
  before update on public.booking_channel_sync_jobs
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 20. BOOKING CHANNEL PUSH LOG
--    Immutable audit of every OTA push operation and its HTTP response.
-- ============================================================================

create table public.booking_channel_push_log (
  id                 uuid        primary key default gen_random_uuid(),
  store_id           uuid        not null references public.stores(id) on delete cascade,
  sync_job_id        uuid        references public.booking_channel_sync_jobs(id) on delete set null,
  channel_listing_id uuid        references public.booking_channel_listings(id) on delete set null,
  provider_id        uuid        references public.booking_channel_providers(id) on delete set null,
  channel            text        not null,
  operation          text        not null
                       check (operation in (
                         'availability_update','rate_update','restriction_update',
                         'listing_update','reservation_confirm','reservation_cancel',
                         'reservation_modify'
                       )),
  request_url        text,
  request_body       text,        -- truncated at 32 KB
  http_status        int,
  response_body      text,        -- truncated at 32 KB
  success            boolean      not null default false,
  error_code         text,
  error_message      text,
  duration_ms        bigint,
  dates_affected     daterange,   -- calendar window this push covered
  created_at         timestamptz  not null default now()
);
comment on table public.booking_channel_push_log is
  'Immutable audit of every OTA push/confirmation. Stores truncated request/response for debugging channel sync discrepancies.';
create index idx_push_log_store    on public.booking_channel_push_log(store_id, created_at desc);
create index idx_push_log_listing  on public.booking_channel_push_log(channel_listing_id, created_at desc)
  where channel_listing_id is not null;
create index idx_push_log_failures on public.booking_channel_push_log(channel, created_at desc)
  where success = false;

-- ============================================================================
-- 21. BOOKING CHANNEL WEBHOOK LOG
--    Inbound OTA reservation webhooks — separate from payment_provider_webhook_log
--    because these correlate to booking resources, not payment providers.
-- ============================================================================

create table public.booking_channel_webhook_log (
  id                     uuid        primary key default gen_random_uuid(),
  store_id               uuid        references public.stores(id) on delete set null,
  channel                text        not null,
  event_type             text        not null,  -- OTA-native event type string
  channel_reservation_id text,                  -- OTA's reservation ID if extractable
  channel_listing_id     text,                  -- OTA's listing ID if extractable
  method                 text        not null,
  path                   text        not null,
  headers                jsonb       not null default '{}',
  body                   text        not null default '',   -- raw body, truncated at 64 KB
  status_code            int         not null default 0,    -- HTTP status returned to OTA
  booking_id             uuid        references public.bookings(id) on delete set null,
  processed              boolean     not null default false,
  error                  text,
  duration_ms            bigint,
  created_at             timestamptz not null default now()
);
comment on table public.booking_channel_webhook_log is
  'Inbound OTA webhook events (Airbnb reservation.created, Booking.com new_reservation, etc.). booking_id set when matched to a booking.';
create index idx_channel_wh_store       on public.booking_channel_webhook_log(store_id, created_at desc);
create index idx_channel_wh_channel     on public.booking_channel_webhook_log(channel, created_at desc);
create index idx_channel_wh_res_id      on public.booking_channel_webhook_log(channel_reservation_id)
  where channel_reservation_id is not null;
create index idx_channel_wh_unprocessed on public.booking_channel_webhook_log(created_at)
  where processed = false and status_code = 200;

-- 180-day retention. OTA webhook log; raw body can be up to 64 KB per row.
-- Mirrors payment webhook retention. delete-on-insert with 0.1% throttle so
-- hot writes are barely affected.
create or replace function public.booking_channel_webhook_log_retention()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (random() < 0.001) then
    delete from public.booking_channel_webhook_log
    where created_at < now() - interval '180 days';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_booking_channel_webhook_log_retention on public.booking_channel_webhook_log;
create trigger trg_booking_channel_webhook_log_retention
  after insert on public.booking_channel_webhook_log
  for each row execute function public.booking_channel_webhook_log_retention();

-- ============================================================================
-- 22. CROSS-FILE FOREIGN KEY CONSTRAINTS
--    orders.booking_id column declared in 0001_commerce.sql as plain uuid;
--    the FK constraint is added here once the bookings table exists.
--    order_lines.supplier_id → suppliers FK already added in 0001_commerce.sql.
-- ============================================================================

alter table public.orders
  add constraint orders_booking_id_fkey
    foreign key (booking_id) references public.bookings(id) on delete restrict;

create index idx_orders_booking on public.orders(booking_id) where booking_id is not null;

-- ============================================================================
-- 23. PRODUCT TYPE EXTENSION
--    Add 'domain' as a valid product type so domain registrations/transfers
--    can be listed in a commerce store. 0001 already includes types through
--    'rental'; this extends it to include 'domain'.
-- ============================================================================

alter table public.products
  drop constraint if exists products_type_check;

alter table public.products
  add constraint products_type_check
    check (type in (
      'simple',
      'bundle',
      'configurable',
      'digital',
      'service',
      'subscription',
      'rental',
      'domain'
    ));

-- ============================================================================
-- RLS — Row Level Security for booking tables
-- (deferred from 0006_rls.sql per its header comment)
-- Follows the same conventions as 0006:
--   • is_store_member(store_id) for store-scoped tables
--   • Append-only tables: SELECT + INSERT only (no UPDATE/DELETE policies)
--   • Log tables: INSERT from authenticated context; SELECT requires store membership
-- ============================================================================

-- enable RLS on all booking + translation tables
alter table public.product_translations            enable row level security;
alter table public.product_variant_translations    enable row level security;
alter table public.product_option_translations     enable row level security;
alter table public.product_option_value_translations enable row level security;
alter table public.collection_translations         enable row level security;
alter table public.store_translations              enable row level security;
alter table public.cancellation_policies           enable row level security;
alter table public.cancellation_policy_translations enable row level security;
alter table public.booking_resources               enable row level security;
alter table public.booking_resource_translations   enable row level security;
alter table public.booking_availability            enable row level security;
alter table public.booking_price_rules             enable row level security;
alter table public.booking_channel_providers       enable row level security;
alter table public.booking_channel_listings        enable row level security;
alter table public.bookings                        enable row level security;
alter table public.booking_reviews                 enable row level security;
alter table public.ical_feeds                      enable row level security;
alter table public.ical_sync_runs                  enable row level security;
alter table public.booking_events                  enable row level security;
alter table public.booking_line_items              enable row level security;
alter table public.booking_modifications           enable row level security;
alter table public.booking_messages                enable row level security;
alter table public.check_in_tokens                 enable row level security;
alter table public.damage_claims                   enable row level security;
alter table public.booking_channel_oauth_states    enable row level security;
alter table public.booking_channel_sync_jobs       enable row level security;
alter table public.booking_channel_push_log        enable row level security;
alter table public.booking_channel_webhook_log     enable row level security;

-- ---- product_translations ---------------------------------------------------
create policy product_translations_all on public.product_translations
  using (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_id and public.is_store_member(p.store_id)
  ));

-- ---- product_variant_translations -------------------------------------------
create policy product_variant_translations_all on public.product_variant_translations
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

-- ---- product_option_translations --------------------------------------------
create policy product_option_translations_all on public.product_option_translations
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

-- ---- product_option_value_translations --------------------------------------
create policy product_option_value_translations_all on public.product_option_value_translations
  using (exists (
    select 1 from public.product_option_values pov
      join public.product_options po on po.id = pov.option_id
      join public.products p on p.id = po.product_id
    where pov.id = option_value_id and public.is_store_member(p.store_id)
  ))
  with check (exists (
    select 1 from public.product_option_values pov
      join public.product_options po on po.id = pov.option_id
      join public.products p on p.id = po.product_id
    where pov.id = option_value_id and public.is_store_member(p.store_id)
  ));

-- ---- collection_translations ------------------------------------------------
create policy collection_translations_all on public.collection_translations
  using (exists (
    select 1 from public.collections c
    where c.id = collection_id and public.is_store_member(c.store_id)
  ))
  with check (exists (
    select 1 from public.collections c
    where c.id = collection_id and public.is_store_member(c.store_id)
  ));

-- ---- store_translations -----------------------------------------------------
create policy store_translations_all on public.store_translations
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- cancellation_policies --------------------------------------------------
create policy cancellation_policies_all on public.cancellation_policies
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- cancellation_policy_translations ---------------------------------------
create policy cancellation_policy_translations_all on public.cancellation_policy_translations
  using (exists (
    select 1 from public.cancellation_policies cp
    where cp.id = policy_id and public.is_store_member(cp.store_id)
  ))
  with check (exists (
    select 1 from public.cancellation_policies cp
    where cp.id = policy_id and public.is_store_member(cp.store_id)
  ));

-- ---- booking_resources ------------------------------------------------------
create policy booking_resources_all on public.booking_resources
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- booking_resource_translations ------------------------------------------
create policy booking_resource_translations_all on public.booking_resource_translations
  using (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ))
  with check (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ));

-- ---- booking_availability ---------------------------------------------------
create policy booking_availability_all on public.booking_availability
  using (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ))
  with check (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ));

-- ---- booking_price_rules ----------------------------------------------------
create policy booking_price_rules_all on public.booking_price_rules
  using (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ))
  with check (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ));

-- ---- booking_channel_providers ----------------------------------------------
create policy booking_channel_providers_all on public.booking_channel_providers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- booking_channel_listings -----------------------------------------------
create policy booking_channel_listings_all on public.booking_channel_listings
  using (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ))
  with check (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ));

-- ---- bookings ---------------------------------------------------------------
create policy bookings_all on public.bookings
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- booking_reviews --------------------------------------------------------
create policy booking_reviews_all on public.booking_reviews
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- ical_feeds -------------------------------------------------------------
create policy ical_feeds_all on public.ical_feeds
  using (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ))
  with check (exists (
    select 1 from public.booking_resources br
    where br.id = resource_id and public.is_store_member(br.store_id)
  ));

-- ---- ical_sync_runs (append-only) -------------------------------------------
create policy ical_sync_runs_select on public.ical_sync_runs for select
  using (exists (
    select 1 from public.ical_feeds f
      join public.booking_resources br on br.id = f.resource_id
    where f.id = feed_id and public.is_store_member(br.store_id)
  ));

create policy ical_sync_runs_insert on public.ical_sync_runs for insert
  with check (exists (
    select 1 from public.ical_feeds f
      join public.booking_resources br on br.id = f.resource_id
    where f.id = feed_id and public.is_store_member(br.store_id)
  ));

-- ---- booking_events (append-only) -------------------------------------------
create policy booking_events_select on public.booking_events for select
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

create policy booking_events_insert on public.booking_events for insert
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- booking_line_items -----------------------------------------------------
create policy booking_line_items_all on public.booking_line_items
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- booking_modifications --------------------------------------------------
create policy booking_modifications_all on public.booking_modifications
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- booking_messages -------------------------------------------------------
create policy booking_messages_all on public.booking_messages
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- check_in_tokens --------------------------------------------------------
create policy check_in_tokens_all on public.check_in_tokens
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- damage_claims ----------------------------------------------------------
create policy damage_claims_all on public.damage_claims
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ))
  with check (exists (
    select 1 from public.bookings b
    where b.id = booking_id and public.is_store_member(b.store_id)
  ));

-- ---- booking_channel_oauth_states -------------------------------------------
create policy booking_channel_oauth_states_all on public.booking_channel_oauth_states
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- booking_channel_sync_jobs ----------------------------------------------
create policy booking_channel_sync_jobs_all on public.booking_channel_sync_jobs
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ---- booking_channel_push_log -----------------------------------------------
-- Append-only: reads require store membership; inserts from authenticated context
create policy booking_channel_push_log_select on public.booking_channel_push_log for select
  using (public.is_store_member(store_id));

create policy booking_channel_push_log_insert on public.booking_channel_push_log for insert
  with check (nullif(current_setting('app.user_id', true), '') is not null);

-- ---- booking_channel_webhook_log --------------------------------------------
-- Append-only: reads require store membership; inserts from authenticated context
-- store_id is nullable (webhook may arrive before store is identified)
create policy booking_channel_webhook_log_select on public.booking_channel_webhook_log for select
  using (
    store_id is null or public.is_store_member(store_id)
  );

create policy booking_channel_webhook_log_insert on public.booking_channel_webhook_log for insert
  with check (nullif(current_setting('app.user_id', true), '') is not null);

commit;
