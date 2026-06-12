/**
 * feeds/types.ts — TypeScript types for feeds + product feed data.
 * Uses explicit `| undefined` on optional fields for exactOptionalPropertyTypes.
 */

export interface MerchantFeedRow {
  id: string;
  store_id: string;
  store_integration_id: string | null;
  channel: string;
  name: string;
  format: string;
  locale: string;
  currency: string;
  country_code: string;
  include_out_of_stock: boolean;
  generation_interval_minutes: number;
  last_generated_at: string | null;
  status: string;
  error_log: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateMerchantFeedInput {
  channel?: string | undefined;
  name?: string | undefined;
  locale?: string | undefined;
  country_code?: string | undefined;
  currency?: string | undefined;
  format?: string | undefined;
  include_out_of_stock?: boolean | undefined;
  generation_interval_minutes?: number | undefined;
  store_integration_id?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface UpdateMerchantFeedInput {
  name?: string | undefined;
  include_out_of_stock?: boolean | undefined;
  generation_interval_minutes?: number | undefined;
  status?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface FeedDataRow {
  id: string;
  variant_id: string;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  google_product_category: string | null;
  condition: string;
  age_group: string | null;
  gender: string | null;
  size_type: string | null;
  size_system: string | null;
  material: string | null;
  pattern: string | null;
  multipack: number | null;
  is_bundle: boolean;
  custom_label_0: string | null;
  custom_label_1: string | null;
  custom_label_2: string | null;
  custom_label_3: string | null;
  custom_label_4: string | null;
  image_url: string | null;
  additional_image_urls: string[] | null;
  excluded_destinations: string[] | null;
  included_destinations: string[] | null;
  ads_redirect: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertFeedDataInput {
  gtin?: string | undefined;
  mpn?: string | undefined;
  brand?: string | undefined;
  google_product_category?: string | undefined;
  condition?: string | undefined;
  age_group?: string | undefined;
  gender?: string | undefined;
  size_type?: string | undefined;
  size_system?: string | undefined;
  material?: string | undefined;
  pattern?: string | undefined;
  multipack?: number | undefined;
  is_bundle?: boolean | undefined;
  custom_label_0?: string | undefined;
  custom_label_1?: string | undefined;
  custom_label_2?: string | undefined;
  custom_label_3?: string | undefined;
  custom_label_4?: string | undefined;
  image_url?: string | undefined;
  ads_redirect?: string | undefined;
}

/** One item in a product feed (Google Shopping / Facebook). */
export interface FeedItem {
  id: string;
  title: string;
  description: string;
  slug: string;
  imageUrl: string;
  price: string; // numeric string
  availability: string;
  condition: string;
  brand: string;
  gtin: string;
  mpn: string;
  googleProductCategory: string;
  ageGroup: string;
  gender: string;
}
