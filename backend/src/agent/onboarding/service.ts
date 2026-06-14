/**
 * agent/onboarding/service.ts — agent-surface onboarding service (B7).
 *
 * Connection CRUD against agent_surface_connections (RLS-gated via withTx),
 * the "2-click" connect flow (OAuth URL / instructions + callback), and the
 * feed-submission pipeline (delegates to surfaces.ts adapters).
 *
 * Credentials are AES-GCM encrypted via lib/secrets before storage and
 * decrypted only inside the submission pipeline. The HTTP to the surface is
 * injectable for tests (httpFetch).
 */

import { withTx } from "../../db/pool.js";
import { config } from "../../config/config.js";
import {
  encodeSecretValue,
  decodeSecretValue,
} from "../../lib/secrets.js";
import {
  submitFeedToSurface,
  CredentialsRequiredError,
  type HttpFetch,
} from "./surfaces.js";
import type {
  AgentSurface,
  ConnectionRow,
  ConnectionView,
  ConnectInstructions,
  CreateConnectionInput,
  ConnectionStatus,
  FeedSubmissionResult,
} from "./types.js";

const secretsKey = config.AUTH_SECRETS_KEY ?? "";

/**
 * Outbound HTTP client used to call the agent surfaces. Overridable in tests
 * (the surfaces are external APIs we don't want to hit in CI). We deliberately
 * do NOT stub the global `fetch`, because the test harness uses global fetch to
 * call our own app over HTTP — stubbing it would break the test client.
 */
let _surfaceFetch: HttpFetch = ((...args) =>
  fetch(...(args as Parameters<typeof fetch>))) as HttpFetch;

/** Test hook: override the surface HTTP client. Returns a restore function. */
export function setSurfaceFetchForTesting(fn: HttpFetch | null): void {
  _surfaceFetch = fn ?? (((...args) =>
    fetch(...(args as Parameters<typeof fetch>))) as HttpFetch);
}

/** Public API base used to build the ACP feed URL handed to surfaces. */
function apiBaseUrl(): string {
  // PUBLIC_API_URL / API_BASE_URL aren't in config; derive from env or default.
  return (
    process.env["PUBLIC_API_URL"] ??
    process.env["API_BASE_URL"] ??
    `http://localhost:${config.PORT}`
  );
}

function mapRow(r: {
  id: string;
  store_id: string;
  surface: string;
  status: string;
  external_account_id: string | null;
  credentials_enc: string | null;
  config: Record<string, unknown> | null;
  last_sync_at: Date | string | null;
  created_at: Date | string;
}): ConnectionRow {
  return {
    id: r.id,
    store_id: r.store_id,
    surface: r.surface as AgentSurface,
    status: r.status as ConnectionStatus,
    external_account_id: r.external_account_id,
    credentials_enc: r.credentials_enc,
    has_credentials: r.credentials_enc != null && r.credentials_enc !== "",
    config: r.config ?? {},
    last_sync_at:
      r.last_sync_at == null
        ? null
        : r.last_sync_at instanceof Date
          ? r.last_sync_at.toISOString()
          : String(r.last_sync_at),
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  };
}

/** Strip the encrypted blob for API responses. */
export function toView(row: ConnectionRow): ConnectionView {
  const { credentials_enc: _omit, ...view } = row;
  void _omit;
  return view;
}

const COLS = `id, store_id, surface, status, external_account_id,
  credentials_enc, config, last_sync_at, created_at`;

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listConnections(storeId: string): Promise<ConnectionView[]> {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLS} FROM agent_surface_connections
       WHERE store_id = $1::uuid ORDER BY created_at ASC`,
      [storeId]
    );
    return rows.map((r) => toView(mapRow(r)));
  });
}

export async function getConnection(
  storeId: string,
  connectionId: string
): Promise<ConnectionRow | null> {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLS} FROM agent_surface_connections
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      [connectionId, storeId]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

export async function getConnectionBySurface(
  storeId: string,
  surface: AgentSurface
): Promise<ConnectionRow | null> {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT ${COLS} FROM agent_surface_connections
       WHERE store_id = $1::uuid AND surface = $2`,
      [storeId, surface]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/**
 * Create or update (upsert on store_id+surface) a connection. Credentials are
 * encrypted before storage. Status defaults to 'connected' when credentials are
 * supplied, otherwise 'pending'.
 */
export async function upsertConnection(
  storeId: string,
  input: CreateConnectionInput
): Promise<ConnectionView> {
  const credEnc =
    input.credentials != null
      ? encodeSecretValue(input.credentials, secretsKey)
      : null;
  const status: ConnectionStatus =
    input.status ?? (input.credentials ? "connected" : "pending");

  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO agent_surface_connections
         (store_id, surface, status, external_account_id, credentials_enc, config)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (store_id, surface) DO UPDATE SET
         status              = EXCLUDED.status,
         external_account_id = COALESCE(EXCLUDED.external_account_id, agent_surface_connections.external_account_id),
         credentials_enc     = COALESCE(EXCLUDED.credentials_enc, agent_surface_connections.credentials_enc),
         config              = agent_surface_connections.config || EXCLUDED.config
       RETURNING ${COLS}`,
      [
        storeId,
        input.surface,
        status,
        input.external_account_id ?? null,
        credEnc,
        JSON.stringify(input.config ?? {}),
      ]
    );
    return toView(mapRow(rows[0]));
  });
}

/** Disconnect (delete) a connection. Returns true if a row was removed. */
export async function deleteConnection(
  storeId: string,
  connectionId: string
): Promise<boolean> {
  return withTx(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM agent_surface_connections
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      [connectionId, storeId]
    );
    return (rowCount ?? 0) > 0;
  });
}

async function patchConnectionState(
  storeId: string,
  connectionId: string,
  status: ConnectionStatus,
  configPatch: Record<string, unknown>,
  touchSync: boolean
): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `UPDATE agent_surface_connections SET
         status = $3,
         config = config || $4::jsonb,
         last_sync_at = CASE WHEN $5 THEN now() ELSE last_sync_at END
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      [
        connectionId,
        storeId,
        status,
        JSON.stringify(configPatch),
        touchSync,
      ]
    );
  });
}

// ── 2-click connect flow ────────────────────────────────────────────────────

/**
 * Return the "2-click" connect descriptor for a surface: the OAuth URL (Google)
 * or registration instructions (ACP), plus the credential-gating disclosure.
 */
export function connectInstructions(
  storeId: string,
  surface: AgentSurface
): ConnectInstructions {
  const isDev = config.APP_ENV !== "production";
  const callbackBase = `${apiBaseUrl().replace(/\/$/, "")}/commerce/stores/${storeId}/agent-surfaces/${surface}`;

  if (surface === "google_merchant") {
    // Real Google OAuth 2.0 authorization URL (content scope). The merchant
    // approves, Google redirects back with a code → callback exchanges it.
    const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"] ?? "";
    const redirect = `${callbackBase}/oauth/callback`;
    const authorize_url = clientId
      ? `https://accounts.google.com/o/oauth2/v2/auth?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirect,
          response_type: "code",
          access_type: "offline",
          prompt: "consent",
          scope: "https://www.googleapis.com/auth/content",
          state: `${storeId}:${surface}`,
        }).toString()
      : null;
    return {
      surface,
      authorize_url,
      instructions: [
        "Click Connect to authorize Cartcrft with your Google Merchant Center account.",
        "Grant the 'Manage your product listings' (content) permission.",
        "Cartcrft stores the OAuth token and submits your catalog to Merchant Center.",
      ],
      mock_available: isDev,
      required_to_go_live: [
        "Google Merchant Center account (numeric merchantId).",
        "GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (OAuth 2.0 client, content scope).",
        "Content API for Shopping enabled on the GCP project.",
      ],
    };
  }

  // chatgpt_acp — registration, no OAuth redirect.
  return {
    surface,
    authorize_url: null,
    instructions: [
      "Complete OpenAI merchant onboarding to obtain a merchant id + API token.",
      "Click Connect and paste your OpenAI merchant id + token.",
      `Cartcrft registers your live ACP feed at ${apiBaseUrl().replace(/\/$/, "")}/acp/${storeId}/feed.`,
    ],
    mock_available: isDev,
    required_to_go_live: [
      "OpenAI merchant onboarding (merchant/seller id).",
      "OpenAI API token with commerce/feed registration permission.",
    ],
  };
}

/**
 * Dev/mock OAuth callback — completes a connection without a real OAuth round
 * trip (mirrors the customer-auth mock-oauth flow). Non-production only;
 * routes gate on APP_ENV.
 */
export async function mockConnect(
  storeId: string,
  surface: AgentSurface,
  externalAccountId: string
): Promise<ConnectionView> {
  return upsertConnection(storeId, {
    surface,
    external_account_id: externalAccountId,
    credentials: `mock-token-${surface}-${storeId}`,
    status: "connected",
    config: { mock: true },
  });
}

// ── Feed-submission pipeline ────────────────────────────────────────────────

/**
 * Generate the product feed and submit it to the surface. The connection must
 * exist and carry credentials (credential-gated). On success the connection's
 * last_sync_at + config bookkeeping are updated and status → connected; on a
 * surface error status → error with the message recorded.
 *
 * `httpFetch` is injectable so tests mock the surface HTTP.
 */
export async function submitFeed(
  storeId: string,
  connectionId: string,
  httpFetch: HttpFetch = _surfaceFetch
): Promise<FeedSubmissionResult> {
  const conn = await getConnection(storeId, connectionId);
  if (!conn) {
    const err = new Error("connection not found") as Error & { code?: string };
    err.code = "NOT_FOUND";
    throw err;
  }

  const credential =
    conn.credentials_enc != null
      ? decodeSecretValue(conn.credentials_enc, secretsKey)
      : null;

  let result: FeedSubmissionResult;
  try {
    result = await submitFeedToSurface(conn.surface, {
      storeId,
      credential,
      externalAccountId: conn.external_account_id,
      apiBaseUrl: apiBaseUrl(),
      httpFetch,
    });
  } catch (err) {
    if (err instanceof CredentialsRequiredError) {
      await patchConnectionState(
        storeId,
        connectionId,
        "pending",
        { last_error: err.message },
        false
      );
      const e = new Error(err.message) as Error & { code?: string };
      e.code = "CREDENTIALS_REQUIRED";
      throw e;
    }
    throw err;
  }

  await patchConnectionState(
    storeId,
    connectionId,
    result.ok ? "connected" : "error",
    {
      last_feed_item_count: result.item_count,
      last_feed_submission_id: result.submission_id,
      last_feed_endpoint: result.endpoint,
      ...(result.error ? { last_error: result.error } : { last_error: null }),
    },
    result.ok
  );

  return result;
}
