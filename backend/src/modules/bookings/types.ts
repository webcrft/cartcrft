/**
 * bookings/types.ts — TypeScript types for the bookings module.
 *
 * Money fields: numeric(15,2) in DB, string in API payloads.
 * All IDs: uuid text strings.
 */

// ── Cancellation Policies ─────────────────────────────────────────────────────

export type CancellationPolicyType =
  | "flexible"
  | "moderate"
  | "strict"
  | "super_strict"
  | "non_refundable"
  | "custom";

export interface CancellationPolicyRule {
  hours_before: number;
  refund_pct: number;
}

export interface CancellationPolicy {
  id: string;
  store_id: string;
  name: string;
  type: CancellationPolicyType;
  rules: CancellationPolicyRule[];
  description: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateCancellationPolicyInput {
  name: string;
  type?: CancellationPolicyType | undefined;
  rules?: CancellationPolicyRule[] | undefined;
  description?: string | undefined;
  is_default?: boolean | undefined;
}

export interface UpdateCancellationPolicyInput {
  name?: string | undefined;
  type?: CancellationPolicyType | undefined;
  rules?: CancellationPolicyRule[] | undefined;
  description?: string | null | undefined;
  is_default?: boolean | undefined;
}

export interface CancellationPolicyTranslation {
  id: string;
  policy_id: string;
  locale: string;
  name: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertCancellationPolicyTranslationInput {
  name?: string | undefined;
  description?: string | undefined;
}

// ── Booking Resources ──────────────────────────────────────────────────────────

export type BookingResourceType =
  | "accommodation"
  | "room"
  | "property"
  | "vehicle"
  | "experience"
  | "desk"
  | "equipment"
  | "event_space";

export type BookingTimeUnit = "nightly" | "daily" | "hourly";

export interface BookingResource {
  id: string;
  store_id: string;
  product_id: string | null;
  name: string;
  type: BookingResourceType;
  parent_id: string | null;
  capacity: number;
  time_unit: BookingTimeUnit;
  min_duration: number;
  max_duration: number | null;
  check_in_time: string | null;
  check_out_time: string | null;
  buffer_hours: number;
  timezone: string;
  base_price: string;
  weekend_price: string | null;
  cleaning_fee: string | null;
  extra_guest_fee: string | null;
  base_capacity: number;
  security_deposit: string | null;
  cancellation_policy_id: string | null;
  instant_bookable: boolean;
  address: Record<string, unknown> | null;
  coordinates: Record<string, unknown> | null;
  amenities: string[];
  rules: Record<string, unknown>;
  is_active: boolean;
  metadata: Record<string, unknown>;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBookingResourceInput {
  name: string;
  type?: BookingResourceType | undefined;
  product_id?: string | undefined;
  parent_id?: string | undefined;
  capacity?: number | undefined;
  time_unit?: BookingTimeUnit | undefined;
  min_duration?: number | undefined;
  max_duration?: number | undefined;
  check_in_time?: string | undefined;
  check_out_time?: string | undefined;
  buffer_hours?: number | undefined;
  timezone?: string | undefined;
  base_price: string;
  weekend_price?: string | undefined;
  cleaning_fee?: string | undefined;
  extra_guest_fee?: string | undefined;
  base_capacity?: number | undefined;
  security_deposit?: string | undefined;
  cancellation_policy_id?: string | undefined;
  instant_bookable?: boolean | undefined;
  address?: Record<string, unknown> | undefined;
  coordinates?: Record<string, unknown> | undefined;
  amenities?: string[] | undefined;
  rules?: Record<string, unknown> | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateBookingResourceInput {
  name?: string | undefined;
  type?: BookingResourceType | undefined;
  product_id?: string | null | undefined;
  parent_id?: string | null | undefined;
  capacity?: number | undefined;
  time_unit?: BookingTimeUnit | undefined;
  min_duration?: number | undefined;
  max_duration?: number | null | undefined;
  check_in_time?: string | null | undefined;
  check_out_time?: string | null | undefined;
  buffer_hours?: number | undefined;
  timezone?: string | undefined;
  base_price?: string | undefined;
  weekend_price?: string | null | undefined;
  cleaning_fee?: string | null | undefined;
  extra_guest_fee?: string | null | undefined;
  base_capacity?: number | undefined;
  security_deposit?: string | null | undefined;
  cancellation_policy_id?: string | null | undefined;
  instant_bookable?: boolean | undefined;
  address?: Record<string, unknown> | null | undefined;
  coordinates?: Record<string, unknown> | null | undefined;
  amenities?: string[] | undefined;
  rules?: Record<string, unknown> | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface BookingResourceTranslation {
  id: string;
  resource_id: string;
  locale: string;
  name: string | null;
  description: string | null;
  rules_text: string | null;
  amenities_labels: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertBookingResourceTranslationInput {
  name?: string | undefined;
  description?: string | undefined;
  rules_text?: string | undefined;
  amenities_labels?: Record<string, string> | undefined;
}

// ── Availability ───────────────────────────────────────────────────────────────

export type AvailabilitySource = "manual" | "ical" | "api" | "channel";

export interface BookingAvailability {
  id: string;
  resource_id: string;
  date: string;
  is_available: boolean;
  custom_price: string | null;
  min_duration: number | null;
  notes: string | null;
  source: AvailabilitySource;
}

export interface SetAvailabilityInput {
  date: string;
  is_available: boolean;
  custom_price?: string | undefined;
  min_duration?: number | undefined;
  notes?: string | undefined;
  source?: AvailabilitySource | undefined;
}

// ── Price Rules ────────────────────────────────────────────────────────────────

export type PriceRuleType =
  | "weekend"
  | "seasonal"
  | "last_minute"
  | "early_bird"
  | "length_of_stay"
  | "occupancy_based"
  | "custom";

export type PriceAdjustmentType = "percentage" | "fixed";

export interface BookingPriceRule {
  id: string;
  resource_id: string;
  name: string;
  type: PriceRuleType;
  min_occupancy_pct: number | null;
  starts_at: string | null;
  ends_at: string | null;
  days_of_week: number[] | null;
  days_before_min: number | null;
  days_before_max: number | null;
  min_duration: number | null;
  adjustment_type: PriceAdjustmentType;
  adjustment_value: string;
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatePriceRuleInput {
  name: string;
  type: PriceRuleType;
  min_occupancy_pct?: number | undefined;
  starts_at?: string | undefined;
  ends_at?: string | undefined;
  days_of_week?: number[] | undefined;
  days_before_min?: number | undefined;
  days_before_max?: number | undefined;
  min_duration?: number | undefined;
  adjustment_type?: PriceAdjustmentType | undefined;
  adjustment_value: string;
  priority?: number | undefined;
  is_active?: boolean | undefined;
}

export interface UpdatePriceRuleInput {
  name?: string | undefined;
  type?: PriceRuleType | undefined;
  min_occupancy_pct?: number | null | undefined;
  starts_at?: string | null | undefined;
  ends_at?: string | null | undefined;
  days_of_week?: number[] | null | undefined;
  days_before_min?: number | null | undefined;
  days_before_max?: number | null | undefined;
  min_duration?: number | null | undefined;
  adjustment_type?: PriceAdjustmentType | undefined;
  adjustment_value?: string | undefined;
  priority?: number | undefined;
  is_active?: boolean | undefined;
}

// ── Price Computation ──────────────────────────────────────────────────────────

export interface BookingPriceResult {
  nightly_rate: string;
  cleaning_fee: string;
  extra_guest_fee: string;
  total_nights: number;
  subtotal: string;
  total: string;
}

// ── Bookings ───────────────────────────────────────────────────────────────────

export type BookingStatus =
  | "inquiry"
  | "pending"
  | "confirmed"
  | "checked_in"
  | "checked_out"
  | "cancelled"
  | "no_show";

export type BookingSourceChannel =
  | "direct"
  | "airbnb"
  | "booking_com"
  | "expedia"
  | "vrbo"
  | "hotels_com"
  | "tripadvisor"
  | "google"
  | "google_vacation_rentals"
  | "google_reserve"
  | "api"
  | "pos";

export interface Booking {
  id: string;
  store_id: string;
  resource_id: string;
  customer_id: string | null;
  order_id: string | null;
  booking_number: string;
  check_in: string;
  check_out: string;
  check_in_time: string | null;
  check_out_time: string | null;
  num_guests: number;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  status: BookingStatus;
  nightly_rate: string | null;
  cleaning_fee: string | null;
  extra_guest_fee: string | null;
  security_deposit: string | null;
  total_nights: number | null;
  subtotal: string | null;
  total: string | null;
  currency: string | null;
  source_channel: BookingSourceChannel;
  channel_reservation_id: string | null;
  channel_listing_id: string | null;
  cancellation_policy_id: string | null;
  special_requests: string | null;
  arrival_instructions: string | null;
  internal_notes: string | null;
  tax_lines: unknown | null;
  tax_amount: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateBookingInput {
  resource_id: string;
  customer_id?: string | undefined;
  check_in: string;
  check_out: string;
  num_guests?: number | undefined;
  guest_name?: string | undefined;
  guest_email?: string | undefined;
  guest_phone?: string | undefined;
  source_channel?: BookingSourceChannel | undefined;
  channel_reservation_id?: string | undefined;
  channel_listing_id?: string | undefined;
  special_requests?: string | undefined;
  currency?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ── Booking Events ─────────────────────────────────────────────────────────────

export interface BookingEvent {
  id: string;
  booking_id: string;
  type: string;
  data: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

// ── Booking Line Items ─────────────────────────────────────────────────────────

export interface BookingLineItem {
  id: string;
  booking_id: string;
  resource_id: string | null;
  variant_id: string | null;
  title: string;
  line_type: string;
  quantity: number;
  unit_price: string;
  total: string;
  currency: string;
  line_check_in: string | null;
  line_check_out: string | null;
  metadata: Record<string, unknown> | null;
}

// ── Booking Modifications ──────────────────────────────────────────────────────

export type ModificationStatus = "pending" | "approved" | "rejected";

export interface BookingModification {
  id: string;
  booking_id: string;
  requested_by: string | null;
  old_check_in: string | null;
  old_check_out: string | null;
  old_num_guests: number | null;
  old_total: string | null;
  old_resource_id: string | null;
  new_check_in: string | null;
  new_check_out: string | null;
  new_num_guests: number | null;
  new_total: string | null;
  new_resource_id: string | null;
  status: ModificationStatus;
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateModificationInput {
  new_check_in?: string | undefined;
  new_check_out?: string | undefined;
  new_num_guests?: number | undefined;
  new_resource_id?: string | undefined;
  notes?: string | undefined;
  requested_by?: string | undefined;
}

// ── Booking Messages ───────────────────────────────────────────────────────────

export interface BookingMessage {
  id: string;
  booking_id: string;
  sender_id: string | null;
  sender_role: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface SendMessageInput {
  sender_id?: string | undefined;
  sender_role: string;
  body: string;
}

// ── Check-In Tokens ────────────────────────────────────────────────────────────

export interface CheckInToken {
  id: string;
  booking_id: string;
  token: string;
  access_type: string;
  valid_from: string | null;
  valid_until: string | null;
  used_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface GenerateCheckInTokenInput {
  access_type?: string | undefined;
  valid_from?: string | undefined;
  valid_until?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ── Damage Claims ──────────────────────────────────────────────────────────────

export type DamageClaimStatus =
  | "pending"
  | "under_review"
  | "resolved"
  | "rejected";

export interface DamageClaim {
  id: string;
  booking_id: string;
  reported_by: string | null;
  description: string;
  claim_amount: string;
  status: DamageClaimStatus;
  evidence: unknown | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDamageClaimInput {
  reported_by?: string | undefined;
  description: string;
  claim_amount: string;
  evidence?: unknown | undefined;
}

export interface UpdateDamageClaimInput {
  status?: DamageClaimStatus | undefined;
  resolution_notes?: string | undefined;
  resolved_at?: string | undefined;
}

// ── Cancel Result ──────────────────────────────────────────────────────────────

export interface CancelBookingResult {
  booking: Booking;
  refund_pct: number;
  refund_amount: string;
}
