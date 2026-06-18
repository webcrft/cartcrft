/**
 * catalog/types.ts — TypeScript types for the catalog module.
 *
 * Mirrors webcrft-mono catalog domain types. Money is string (API boundary)
 * but stored as numeric(15,2) in the DB.
 *
 * Note: With exactOptionalPropertyTypes=true, optional properties that may
 * be undefined are typed as `?: T | undefined`.
 */

// ── Products ──────────────────────────────────────────────────────────────────

export type ProductType =
  | "simple"
  | "bundle"
  | "configurable"
  | "digital"
  | "service"
  | "subscription"
  | "rental";

export type ProductStatus = "draft" | "active" | "archived";

export interface ProductPublic {
  id: string;
  store_id: string;
  title: string;
  slug: string;
  description: string | null;
  type: ProductType;
  status: ProductStatus;
  vendor: string | null;
  seo_title: string | null;
  seo_desc: string | null;
  metadata: Record<string, unknown> | null;
  avg_rating: string;
  review_count: number;
  created_at: string;
  updated_at: string;
  variants?: VariantPublic[] | undefined;
  media?: MediaPublic[] | undefined;
  options?: OptionWithValues[] | undefined;
  bundle_items?: BundleItemPublic[] | undefined;
}

export interface CreateProductInput {
  title: string;
  slug?: string | undefined;
  description?: string | undefined;
  type?: ProductType | undefined;
  status?: ProductStatus | undefined;
  vendor?: string | undefined;
  seo_title?: string | undefined;
  seo_desc?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  price?: string | undefined;
  images?: string[] | undefined;
}

export interface UpdateProductInput {
  title?: string | undefined;
  slug?: string | undefined;
  description?: string | undefined;
  type?: ProductType | undefined;
  status?: ProductStatus | undefined;
  vendor?: string | undefined;
  seo_title?: string | undefined;
  seo_desc?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ── Variants ──────────────────────────────────────────────────────────────────

export interface VariantPublic {
  id: string;
  product_id: string;
  sku: string | null;
  barcode: string | null;
  title: string;
  price: string;
  compare_at_price: string | null;
  cost_price: string | null;
  weight_g: string | null;
  requires_shipping: boolean;
  is_taxable: boolean;
  track_inventory: boolean;
  allow_backorder: boolean;
  position: number;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CreateVariantInput {
  sku?: string | undefined;
  barcode?: string | undefined;
  title?: string | undefined;
  price: string; // required, > 0
  compare_at_price?: string | undefined;
  cost_price?: string | undefined;
  weight_g?: number | undefined;
  requires_shipping?: boolean | undefined;
  is_taxable?: boolean | undefined;
  track_inventory?: boolean | undefined;
  allow_backorder?: boolean | undefined;
  position?: number | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  inventory_quantity?: number | undefined;
}

export interface UpdateVariantInput {
  sku?: string | undefined;
  barcode?: string | undefined;
  title?: string | undefined;
  price?: string | undefined;
  compare_at_price?: string | undefined;
  cost_price?: string | undefined;
  weight_g?: number | undefined;
  requires_shipping?: boolean | undefined;
  is_taxable?: boolean | undefined;
  track_inventory?: boolean | undefined;
  allow_backorder?: boolean | undefined;
  position?: number | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface OptionPublic {
  id: string;
  product_id: string;
  name: string;
  position: number;
}

export interface OptionValuePublic {
  id: string;
  option_id: string;
  value: string;
  position: number;
}

export interface OptionWithValues extends OptionPublic {
  values: OptionValuePublic[];
}

export interface CreateOptionInput {
  name: string;
  values?: string[] | undefined;
  position?: number | undefined;
}

// ── Media ─────────────────────────────────────────────────────────────────────

export type MediaType = "image" | "video" | "model_3d";

export interface MediaPublic {
  id: string;
  product_id: string;
  variant_id: string | null;
  url: string;
  cdn_url: string | null;
  type: MediaType;
  alt_text: string | null;
  position: number;
  created_at: string;
}

export interface AddMediaInput {
  url: string;
  type?: MediaType | undefined;
  variant_id?: string | undefined;
  alt_text?: string | undefined;
  position?: number | undefined;
}

// ── Bundle items ──────────────────────────────────────────────────────────────

export interface BundleItemPublic {
  id: string;
  product_id: string;
  variant_id: string;
  quantity: number;
  is_optional: boolean;
  position: number;
}

export interface AddBundleItemInput {
  variant_id: string;
  quantity?: number | undefined;
  is_optional?: boolean | undefined;
  position?: number | undefined;
}

export interface UpdateBundleItemInput {
  quantity?: number | undefined;
  is_optional?: boolean | undefined;
  position?: number | undefined;
}

// ── Digital files ─────────────────────────────────────────────────────────────

export interface DigitalFilePublic {
  id: string;
  store_id: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  file_url: string;
  file_size: string | null;
  mime_type: string | null;
  version: string | null;
  download_limit: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateDigitalFileInput {
  name: string;
  file_url: string;
  variant_id?: string | undefined;
  file_size?: number | undefined;
  mime_type?: string | undefined;
  version?: string | undefined;
  download_limit?: number | undefined;
  is_active?: boolean | undefined;
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface ReviewPublic {
  id: string;
  store_id: string;
  product_id: string;
  customer_id: string | null;
  order_id: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
  status: ReviewStatus;
  is_verified_purchase: boolean;
  helpful_count: number;
  media_urls: unknown | null;
  reply: string | null;
  replied_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateReviewInput {
  customer_id?: string | undefined;
  order_id?: string | undefined;
  rating: number; // 1-5
  title?: string | undefined;
  body?: string | undefined;
  reviewer_name?: string | undefined;
  reviewer_email?: string | undefined;
  media_urls?: unknown | undefined;
}

export interface UpdateReviewInput {
  status?: ReviewStatus | undefined;
  reply?: string | undefined;
}

// ── Collections ───────────────────────────────────────────────────────────────

export interface CollectionPublic {
  id: string;
  store_id: string;
  title: string;
  slug: string;
  description: string | null;
  parent_id: string | null;
  image_url: string | null;
  seo_title: string | null;
  seo_desc: string | null;
  sort_order: string | null;
  is_smart: boolean;
  smart_match: "all" | "any";
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCollectionInput {
  title: string;
  slug?: string | undefined;
  description?: string | undefined;
  parent_id?: string | undefined;
  image_url?: string | undefined;
  seo_title?: string | undefined;
  seo_desc?: string | undefined;
  sort_order?: string | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateCollectionInput {
  title?: string | undefined;
  slug?: string | undefined;
  description?: string | undefined;
  parent_id?: string | undefined;
  image_url?: string | undefined;
  seo_title?: string | undefined;
  seo_desc?: string | undefined;
  sort_order?: string | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ── Collection rules ──────────────────────────────────────────────────────────

export type RuleField = "title" | "vendor" | "status" | "type" | "tag";
export type RuleRelation =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "greater_than"
  | "less_than";

export interface CollectionRulePublic {
  id: string;
  collection_id: string;
  field: RuleField;
  relation: RuleRelation;
  value: string;
  position: number;
  created_at: string;
}

export interface AddCollectionRuleInput {
  field: RuleField;
  relation: RuleRelation;
  value: string;
  position?: number | undefined;
}

// ── Price lists ───────────────────────────────────────────────────────────────

export type PriceListType =
  | "retail"
  | "wholesale"
  | "vip"
  | "staff"
  | "custom";

export interface PriceListPublic {
  id: string;
  store_id: string;
  name: string;
  currency: string;
  type: PriceListType;
  is_default: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePriceListInput {
  name: string;
  currency: string;
  type?: PriceListType | undefined;
  is_default?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdatePriceListInput {
  name?: string | undefined;
  currency?: string | undefined;
  type?: PriceListType | undefined;
  is_default?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface PriceListItemPublic {
  id: string;
  price_list_id: string;
  variant_id: string;
  price: string;
  min_qty: number;
  max_qty: number | null;
  created_at: string;
}

export interface UpsertPriceListItemInput {
  variant_id: string;
  price: string;
  min_qty?: number | undefined;
  max_qty?: number | undefined;
}

export interface UpdatePriceListItemInput {
  price?: string | undefined;
  min_qty?: number | undefined;
  max_qty?: number | undefined;
}

// ── Metafields ────────────────────────────────────────────────────────────────

export type MetafieldType =
  | "string"
  | "integer"
  | "boolean"
  | "json"
  | "date"
  | "url";

export interface MetafieldPublic {
  id: string;
  store_id: string;
  owner_resource: string;
  owner_id: string;
  namespace: string;
  key: string;
  value: string | null;
  type: MetafieldType;
  created_at: string;
  updated_at: string;
}

export interface UpsertMetafieldInput {
  owner_resource: string;
  owner_id: string;
  namespace: string;
  key: string;
  value?: string | undefined;
  type?: MetafieldType | undefined;
}

export interface UpdateMetafieldInput {
  value?: string | undefined;
  type?: MetafieldType | undefined;
}

export interface MetafieldDefinitionPublic {
  id: string;
  store_id: string;
  namespace: string;
  key: string;
  name: string;
  owner_resource: string;
  description: string | null;
  type: MetafieldType;
  validations: unknown;
  is_required: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateMetafieldDefinitionInput {
  namespace: string;
  key: string;
  name: string;
  owner_resource: string;
  description?: string | undefined;
  type?: MetafieldType | undefined;
  validations?: unknown | undefined;
  is_required?: boolean | undefined;
}

export interface UpdateMetafieldDefinitionInput {
  name?: string | undefined;
  description?: string | undefined;
  type?: MetafieldType | undefined;
  validations?: unknown | undefined;
  is_required?: boolean | undefined;
}

// ── Translations ──────────────────────────────────────────────────────────────

export type TranslationResourceType =
  | "product"
  | "variant"
  | "option"
  | "option_value"
  | "collection";

export interface TranslationPublic {
  locale: string;
  fields: Record<string, string | null>;
}

export interface UpsertTranslationInput {
  fields: Record<string, string | null>;
}
