/**
 * agent/onboarding/types.ts — types for agent-surface onboarding (B7).
 *
 * An "agent surface" is an external channel where AI shopping agents discover
 * and transact products. We support:
 *   - google_merchant : Google AI shopping via Merchant Center (Content API
 *                        for Shopping). Products land in Google's Shopping Graph.
 *   - chatgpt_acp      : ChatGPT / OpenAI agentic commerce via ACP feed
 *                        registration (points the surface at /acp/:storeId/feed).
 */

export type AgentSurface = "google_merchant" | "chatgpt_acp";

export const AGENT_SURFACES: readonly AgentSurface[] = [
  "google_merchant",
  "chatgpt_acp",
] as const;

export type ConnectionStatus =
  | "disconnected"
  | "pending"
  | "connected"
  | "error";

/** Public view of a connection (credentials never exposed). */
export interface ConnectionView {
  id: string;
  store_id: string;
  surface: AgentSurface;
  status: ConnectionStatus;
  external_account_id: string | null;
  /** True when an encrypted credential blob is present (boolean only). */
  has_credentials: boolean;
  config: Record<string, unknown>;
  last_sync_at: string | null;
  created_at: string;
}

/** Internal row including the encrypted credential blob. */
export interface ConnectionRow extends ConnectionView {
  credentials_enc: string | null;
}

export interface CreateConnectionInput {
  surface: AgentSurface;
  external_account_id?: string | undefined;
  /** Raw credentials (encrypted before storage). For dev/manual connect. */
  credentials?: string | undefined;
  config?: Record<string, unknown> | undefined;
  status?: ConnectionStatus | undefined;
}

/** Result of submitting the product feed to a surface. */
export interface FeedSubmissionResult {
  surface: AgentSurface;
  ok: boolean;
  item_count: number;
  /** Surface-assigned submission/batch id, when available. */
  submission_id: string | null;
  /** Endpoint the request was (or would be) sent to. */
  endpoint: string;
  /** Populated on failure. */
  error?: string | undefined;
}

/** A "2-click" connect descriptor returned to the wizard. */
export interface ConnectInstructions {
  surface: AgentSurface;
  /** OAuth authorization URL (Google) — open this, then call the callback. */
  authorize_url: string | null;
  /** Human-readable steps for surfaces without OAuth (ACP). */
  instructions: string[];
  /** True in dev — a mock-oauth callback is available without real creds. */
  mock_available: boolean;
  /** What must be supplied to go live (credential-gating disclosure). */
  required_to_go_live: string[];
}
