/**
 * agents/types.ts — TypeScript types for the agent registry + mandates module.
 *
 * Agent-native trust layer (T3.3 AP2-style verifiable consent chain).
 *
 * Data model is driven by backend/migrations/0005_agents.sql.
 * The mandate schema is extended here for the AP2 intent→cart→payment chain
 * which requires additional columns (mandate_type, payload, parent_mandate_id,
 * signature, public_key) — added via migration 0009_agents_ext.sql.
 */

// ── Agent types ───────────────────────────────────────────────────────────────

export type AgentType =
  | "webhook"
  | "internal"
  | "mcp"
  | "scheduled"
  | "event_driven";

export type AgentStatus = "active" | "paused" | "error" | "disabled";

export interface AgentRow {
  id: string;
  store_id: string;
  name: string;
  slug: string;
  description: string | null;
  agent_type: AgentType;
  endpoint_url: string | null;
  auth_type: string;
  // public_key: DER-encoded ed25519 public key as hex string
  public_key: string | null;
  timeout_ms: number;
  max_retries: number;
  retry_backoff_ms: number;
  cron_expression: string | null;
  event_triggers: string[];
  status: AgentStatus;
  scopes: string[];
  spend_limit: string | null;      // numeric(15,2) as string
  spend_window: string | null;     // e.g. '24h', '7d'
  last_invoked_at: Date | null;
  last_error: string | null;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface AgentPublic {
  id: string;
  store_id: string;
  name: string;
  slug: string;
  description: string | null;
  agent_type: AgentType;
  endpoint_url: string | null;
  auth_type: string;
  public_key: string | null;
  timeout_ms: number;
  max_retries: number;
  retry_backoff_ms: number;
  cron_expression: string | null;
  event_triggers: string[];
  status: AgentStatus;
  scopes: string[];
  spend_limit: string | null;
  spend_window: string | null;
  last_invoked_at: string | null;
  last_error: string | null;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Returned once on agent creation — private key is NEVER stored. */
export interface AgentCreated extends AgentPublic {
  private_key_pem: string; // PKCS#8 PEM, shown once
}

export interface CreateAgentInput {
  name: string;
  slug?: string;
  description?: string;
  agent_type?: AgentType;
  endpoint_url?: string;
  auth_type?: string;
  timeout_ms?: number;
  max_retries?: number;
  retry_backoff_ms?: number;
  cron_expression?: string;
  event_triggers?: string[];
  scopes?: string[];
  spend_limit?: string;
  spend_window?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  endpoint_url?: string;
  auth_type?: string;
  timeout_ms?: number;
  max_retries?: number;
  retry_backoff_ms?: number;
  cron_expression?: string;
  event_triggers?: string[];
  status?: AgentStatus;
  scopes?: string[];
  spend_limit?: string;
  spend_window?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  is_active?: boolean;
}

// ── Mandate types ─────────────────────────────────────────────────────────────

export type MandateType = "intent" | "cart" | "payment";

/**
 * Mandate payload shapes per AP2 spec:
 *  - intent: natural-language description + constraints
 *  - cart:   cart_id + max_total
 *  - payment: checkout_id + amount
 */
export type MandatePayload =
  | IntentPayload
  | CartPayload
  | PaymentPayload;

export interface IntentPayload {
  description: string;
  constraints?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CartPayload {
  cart_id: string;
  max_total: string; // numeric string
  currency?: string;
  [key: string]: unknown;
}

export interface PaymentPayload {
  checkout_id: string;
  amount: string; // numeric string
  currency?: string;
  [key: string]: unknown;
}

export interface MandateRow {
  id: string;
  agent_id: string;
  store_id: string;
  mandate_type: MandateType;
  payload: MandatePayload;
  parent_mandate_id: string | null;
  /** ed25519 signature over canonical JSON of {id, agent_id, store_id, mandate_type, payload, parent_mandate_id, expires_at} */
  signature: string | null;         // hex-encoded
  /** ed25519 public key at time of signing (hex-encoded DER) */
  signing_key: string | null;
  name: string;
  scopes: string[];
  resource_type: string | null;
  resource_ids: string[];
  rate_limit_rpm: number | null;
  valid_from: Date;
  valid_until: Date | null;
  expires_at: Date | null;           // alias used in AP2 verify; mirrors valid_until
  is_active: boolean;
  revoked_at: Date | null;
  revoke_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface MandatePublic {
  id: string;
  agent_id: string;
  store_id: string;
  mandate_type: MandateType;
  payload: MandatePayload;
  parent_mandate_id: string | null;
  signature: string | null;
  signing_key: string | null;
  name: string;
  scopes: string[];
  resource_type: string | null;
  resource_ids: string[];
  rate_limit_rpm: number | null;
  valid_from: string;
  valid_until: string | null;
  expires_at: string | null;
  is_active: boolean;
  revoked_at: string | null;
  revoke_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateMandateInput {
  agent_id: string;
  mandate_type: MandateType;
  payload: MandatePayload;
  parent_mandate_id?: string;
  signature?: string;
  name?: string;
  scopes?: string[];
  resource_type?: string;
  resource_ids?: string[];
  rate_limit_rpm?: number;
  expires_at?: string;  // ISO timestamp
  metadata?: Record<string, unknown>;
}

export interface MandateVerifyResult {
  valid: boolean;
  mandate: MandatePublic | null;
  chain: MandatePublic[];
  errors: string[];
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export type AuditLogStatus =
  | "success"
  | "failure"
  | "partial"
  | "timeout"
  | "rate_limited"
  | "unauthorized";

export interface AuditLogRow {
  id: string;
  agent_id: string;
  mandate_id: string | null;
  store_id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  status: AuditLogStatus;
  error_message: string | null;
  duration_ms: number | null;
  ip_address: string | null;
  correlation_id: string | null;
  created_at: Date;
}

export interface AuditLogPublic {
  id: string;
  agent_id: string;
  mandate_id: string | null;
  store_id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  status: AuditLogStatus;
  error_message: string | null;
  duration_ms: number | null;
  ip_address: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface InsertAuditLogInput {
  agent_id: string;
  mandate_id?: string;
  store_id: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  request_payload?: Record<string, unknown>;
  response_payload?: Record<string, unknown>;
  status?: AuditLogStatus;
  error_message?: string;
  duration_ms?: number;
  ip_address?: string;
  correlation_id?: string;
}

// ── Agent header context (from attribution middleware) ────────────────────────

export interface AgentHeaderCtx {
  agentId: string;
  storeId: string;
  /** Raw signature from X-Cartcrft-Signature (hex) */
  signature: string;
  /** Unix timestamp from X-Cartcrft-Timestamp header (seconds) */
  timestamp: number;
}
