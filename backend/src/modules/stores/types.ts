/**
 * stores/types.ts — shared types for the stores module.
 *
 * All DB-facing types use string IDs (uuid text).
 * Money fields are string (numeric) in API payloads; never float.
 */

export interface Store {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  currency: string;
  weight_unit: string;
  timezone: string;
  country_code: string | null;
  email: string | null;
  phone: string | null;
  address: Record<string, unknown> | null;
  enable_currency_conversion: boolean;
  domain: string | null;
  supported_locales: string[];
  default_locale: string;
  metadata: Record<string, unknown>;
  is_active: boolean;
  taken_down_at: string | null;
  taken_down_reason: string | null;
  // auth columns (from 0003_customer_auth.sql)
  auth_enabled: boolean;
  auth_allowed_origins: string[];
  auth_jwt_secret: string | null; // never returned in API responses
  auth_token_expiry_seconds: number;
  auth_refresh_expiry_seconds: number;
  auth_magic_link_enabled: boolean;
  auth_otp_enabled: boolean;
  auth_social_providers: Record<string, unknown>;
  auth_require_email_verify: boolean;
  auth_max_sessions: number;
  created_at: string;
  updated_at: string;
}

/** Subset of Store safe to return in API responses (no auth_jwt_secret). */
export type StorePublic = Omit<Store, "auth_jwt_secret">;

export interface CreateStoreInput {
  name: string;
  slug?: string | undefined;
  currency?: string | undefined;
  timezone?: string | undefined;
  country_code?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  weight_unit?: string | undefined;
  enable_currency_conversion?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateStoreInput {
  name?: string | undefined;
  slug?: string | undefined;
  currency?: string | undefined;
  timezone?: string | undefined;
  country_code?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  weight_unit?: string | undefined;
  is_active?: boolean | undefined;
  enable_currency_conversion?: boolean | undefined;
  domain?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}
