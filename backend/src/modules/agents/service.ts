/**
 * agents/service.ts — Agent registry + mandates service.
 *
 * Responsibilities:
 *  1. Agent CRUD (create with ed25519 keypair, list/get/update/revoke)
 *  2. Mandate create (with chain validation) + verify
 *  3. Audit log insert
 *  4. Spend window enforcement (verifyAgentCheckout)
 *
 * Signature scheme:
 *  - Agent keypair: ed25519 via node:crypto generateKeyPairSync
 *  - Private key: returned once in PKCS#8 PEM, never stored
 *  - Public key: stored as hex-encoded DER (SubjectPublicKeyInfo / spki format)
 *  - Mandate signature: ed25519 over stable-stringified canonical JSON envelope
 *    { id, agent_id, store_id, mandate_type, payload, parent_mandate_id, expires_at }
 *    where all values are normalised (nulls explicit, no undefined)
 *  - Request signature (see agent-auth.ts): ed25519 over
 *    METHOD + "\n" + path + "\n" + sha256(body) + "\n" + timestamp
 *
 * Chain validation rules (AP2 shape):
 *  - intent: no parent; payload must have { description }
 *  - cart:   parent must be an active, unexpired intent mandate for same agent
 *            payload must have { cart_id, max_total }
 *  - payment: parent must be an active, unexpired cart mandate for same agent
 *             payload must have { checkout_id, amount }
 *             amount must be <= parent cart max_total
 */

import { generateKeyPairSync, createVerify, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { getPool } from "../../db/pool.js";
import type {
  AgentRow,
  AgentPublic,
  AgentCreated,
  CreateAgentInput,
  UpdateAgentInput,
  MandateRow,
  MandatePublic,
  MandatePayload,
  IntentPayload,
  CartPayload,
  PaymentPayload,
  CreateMandateInput,
  MandateVerifyResult,
  AuditLogPublic,
  InsertAuditLogInput,
  MandateType,
} from "./types.js";

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Generate a fresh ed25519 keypair. Returns {publicKeyHex, privateKeyPem}. */
export function generateAgentKeyPair(): {
  publicKeyHex: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKeyHex: (publicKey as Buffer).toString("hex"),
    privateKeyPem: privateKey as string,
  };
}

/** Import a hex-encoded DER public key into a KeyObject for verification. */
function importPublicKey(hexDer: string): Buffer {
  return Buffer.from(hexDer, "hex");
}

// ── Canonical JSON for mandate signing ────────────────────────────────────────

/**
 * Produce a stable (sorted-key) JSON string of the mandate envelope.
 * Used both for signing and for verification.
 * Fields: id, agent_id, store_id, mandate_type, payload, parent_mandate_id, expires_at
 */
export function canonicalMandateJson(fields: {
  id: string;
  agent_id: string;
  store_id: string;
  mandate_type: MandateType;
  payload: MandatePayload;
  parent_mandate_id: string | null;
  expires_at: string | null;
}): string {
  // Sort keys deterministically
  return JSON.stringify({
    agent_id: fields.agent_id,
    expires_at: fields.expires_at,
    id: fields.id,
    mandate_type: fields.mandate_type,
    parent_mandate_id: fields.parent_mandate_id,
    payload: fields.payload,
    store_id: fields.store_id,
  });
}

/**
 * Verify a mandate's ed25519 signature.
 * Returns true if the signature is valid.
 *
 * Note: ed25519 uses one-shot sign/verify (no hash algorithm), so we use
 * the synchronous crypto.verify(null, data, key, signature) API.
 */
export function verifyMandateSignature(
  fields: Parameters<typeof canonicalMandateJson>[0],
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const canonical = Buffer.from(canonicalMandateJson(fields), "utf8");
    const pubKeyBuf = importPublicKey(publicKeyHex);
    const sigBuf = Buffer.from(signatureHex, "hex");
    return cryptoVerify(
      null,
      canonical,
      { key: pubKeyBuf, format: "der", type: "spki" },
      sigBuf
    );
  } catch {
    return false;
  }
}

/**
 * Sign a mandate envelope using a PKCS#8 PEM private key.
 * Returns hex-encoded signature.
 *
 * Note: ed25519 uses one-shot sign/verify — no hash algorithm parameter.
 */
export function signMandateEnvelope(
  fields: Parameters<typeof canonicalMandateJson>[0],
  privateKeyPem: string
): string {
  const canonical = Buffer.from(canonicalMandateJson(fields), "utf8");
  const sig = cryptoSign(null, canonical, { key: privateKeyPem, format: "pem", type: "pkcs8" });
  return sig.toString("hex");
}

// ── Agent row → public ────────────────────────────────────────────────────────

function agentToPublic(row: AgentRow): AgentPublic {
  return {
    id: row.id,
    store_id: row.store_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    agent_type: row.agent_type,
    endpoint_url: row.endpoint_url,
    auth_type: row.auth_type,
    public_key: row.public_key,
    timeout_ms: row.timeout_ms,
    max_retries: row.max_retries,
    retry_backoff_ms: row.retry_backoff_ms,
    cron_expression: row.cron_expression,
    event_triggers: row.event_triggers,
    status: row.status,
    scopes: row.scopes,
    spend_limit: row.spend_limit,
    spend_window: row.spend_window,
    last_invoked_at: row.last_invoked_at?.toISOString() ?? null,
    last_error: row.last_error,
    config: row.config,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ── Mandate row → public ──────────────────────────────────────────────────────

function mandateToPublic(row: MandateRow): MandatePublic {
  return {
    id: row.id,
    agent_id: row.agent_id,
    store_id: row.store_id,
    mandate_type: row.mandate_type,
    payload: row.payload,
    parent_mandate_id: row.parent_mandate_id,
    signature: row.signature,
    signing_key: row.signing_key,
    name: row.name,
    scopes: row.scopes,
    resource_type: row.resource_type,
    resource_ids: row.resource_ids,
    rate_limit_rpm: row.rate_limit_rpm,
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until?.toISOString() ?? null,
    expires_at: row.expires_at?.toISOString() ?? null,
    is_active: row.is_active,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ── Agent CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new agent.
 * Generates an ed25519 keypair; private key returned once, public key stored.
 */
export async function createAgent(
  storeId: string,
  input: CreateAgentInput
): Promise<AgentCreated> {
  const pool = getPool();
  const { publicKeyHex, privateKeyPem } = generateAgentKeyPair();

  const slug =
    input.slug ??
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) +
    "-" +
    Math.random().toString(36).slice(2, 7);

  const { rows } = await pool.query<AgentRow>(
    `INSERT INTO agents (
       store_id, name, slug, description, agent_type,
       endpoint_url, auth_type, public_key,
       timeout_ms, max_retries, retry_backoff_ms,
       cron_expression, event_triggers,
       scopes, spend_limit, spend_window,
       config, metadata
     ) VALUES (
       $1::uuid, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13,
       $14, $15, $16,
       $17, $18
     )
     RETURNING
       id::text, store_id::text, name, slug, description,
       agent_type, endpoint_url, auth_type, public_key,
       timeout_ms, max_retries, retry_backoff_ms,
       cron_expression, event_triggers, status,
       scopes, spend_limit::text, spend_window,
       last_invoked_at, last_error,
       config, metadata, created_at, updated_at`,
    [
      storeId,
      input.name,
      slug,
      input.description ?? null,
      input.agent_type ?? "webhook",
      input.endpoint_url ?? null,
      input.auth_type ?? "bearer",
      publicKeyHex,
      input.timeout_ms ?? 30000,
      input.max_retries ?? 3,
      input.retry_backoff_ms ?? 1000,
      input.cron_expression ?? null,
      input.event_triggers ?? [],
      input.scopes ?? [],
      input.spend_limit ?? null,
      input.spend_window ?? null,
      JSON.stringify(input.config ?? {}),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  const row = rows[0]!;
  return {
    ...agentToPublic(row),
    private_key_pem: privateKeyPem,
  };
}

/** List agents for a store. */
export async function listAgents(
  storeId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<AgentPublic[]> {
  const pool = getPool();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const { rows } = await pool.query<AgentRow>(
    `SELECT
       id::text, store_id::text, name, slug, description,
       agent_type, endpoint_url, auth_type, public_key,
       timeout_ms, max_retries, retry_backoff_ms,
       cron_expression, event_triggers, status,
       scopes, spend_limit::text, spend_window,
       last_invoked_at, last_error,
       config, metadata, created_at, updated_at
     FROM agents
     WHERE store_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows.map(agentToPublic);
}

/** Get a single agent. Returns null if not found or wrong store. */
export async function getAgent(
  storeId: string,
  agentId: string
): Promise<AgentPublic | null> {
  const pool = getPool();
  const { rows } = await pool.query<AgentRow>(
    `SELECT
       id::text, store_id::text, name, slug, description,
       agent_type, endpoint_url, auth_type, public_key,
       timeout_ms, max_retries, retry_backoff_ms,
       cron_expression, event_triggers, status,
       scopes, spend_limit::text, spend_window,
       last_invoked_at, last_error,
       config, metadata, created_at, updated_at
     FROM agents
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [agentId, storeId]
  );
  if (!rows[0]) return null;
  return agentToPublic(rows[0]);
}

/** Get agent by ID only (used by attribution middleware — crosses store boundaries for lookup). */
export async function getAgentById(
  agentId: string
): Promise<AgentRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<AgentRow>(
    `SELECT
       id::text, store_id::text, name, slug, description,
       agent_type, endpoint_url, auth_type, public_key,
       timeout_ms, max_retries, retry_backoff_ms,
       cron_expression, event_triggers, status,
       scopes, spend_limit::text, spend_window,
       last_invoked_at, last_error,
       config, metadata, created_at, updated_at
     FROM agents
     WHERE id = $1::uuid`,
    [agentId]
  );
  return rows[0] ?? null;
}

/** Update an agent. Returns false if not found. */
export async function updateAgent(
  storeId: string,
  agentId: string,
  input: UpdateAgentInput
): Promise<boolean> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [agentId, storeId];
  let i = 3;

  if (input.name !== undefined) {
    sets.push(`name = $${i++}`);
    vals.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push(`description = $${i++}`);
    vals.push(input.description);
  }
  if (input.endpoint_url !== undefined) {
    sets.push(`endpoint_url = $${i++}`);
    vals.push(input.endpoint_url);
  }
  if (input.auth_type !== undefined) {
    sets.push(`auth_type = $${i++}`);
    vals.push(input.auth_type);
  }
  if (input.timeout_ms !== undefined) {
    sets.push(`timeout_ms = $${i++}`);
    vals.push(input.timeout_ms);
  }
  if (input.max_retries !== undefined) {
    sets.push(`max_retries = $${i++}`);
    vals.push(input.max_retries);
  }
  if (input.retry_backoff_ms !== undefined) {
    sets.push(`retry_backoff_ms = $${i++}`);
    vals.push(input.retry_backoff_ms);
  }
  if (input.cron_expression !== undefined) {
    sets.push(`cron_expression = $${i++}`);
    vals.push(input.cron_expression);
  }
  if (input.event_triggers !== undefined) {
    sets.push(`event_triggers = $${i++}`);
    vals.push(input.event_triggers);
  }
  if (input.status !== undefined) {
    sets.push(`status = $${i++}`);
    vals.push(input.status);
  }
  if (input.scopes !== undefined) {
    sets.push(`scopes = $${i++}`);
    vals.push(input.scopes);
  }
  if (input.spend_limit !== undefined) {
    sets.push(`spend_limit = $${i++}::numeric`);
    vals.push(input.spend_limit);
  }
  if (input.spend_window !== undefined) {
    sets.push(`spend_window = $${i++}`);
    vals.push(input.spend_window);
  }
  if (input.config !== undefined) {
    sets.push(`config = $${i++}`);
    vals.push(JSON.stringify(input.config));
  }
  if (input.metadata !== undefined) {
    sets.push(`metadata = $${i++}`);
    vals.push(JSON.stringify(input.metadata));
  }

  if (sets.length === 0) return true;

  const { rowCount } = await pool.query(
    `UPDATE agents SET ${sets.join(", ")}
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    vals
  );
  return (rowCount ?? 0) > 0;
}

/** Revoke (disable) an agent. Sets status = 'disabled'. */
export async function revokeAgent(
  storeId: string,
  agentId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE agents SET status = 'disabled'
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [agentId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Mandate create ────────────────────────────────────────────────────────────

/**
 * Parse a spend_window string like '24h', '7d', '30d' into an interval string
 * suitable for Postgres: '24 hours', '7 days', etc.
 */
function parseSpendWindow(w: string): string {
  const m = w.match(/^(\d+)(h|d|m)$/);
  if (!m) return "24 hours";
  const n = parseInt(m[1]!, 10);
  const unit = m[2];
  if (unit === "h") return `${n} hours`;
  if (unit === "d") return `${n} days`;
  if (unit === "m") return `${n} minutes`;
  return "24 hours";
}

/**
 * Validate the AP2 mandate chain constraints (called in createMandate).
 * Returns a list of error strings; empty = valid.
 */
async function validateMandateChain(
  pool: ReturnType<typeof getPool>,
  input: CreateMandateInput,
  agentId: string,
  storeId: string
): Promise<string[]> {
  const errors: string[] = [];

  if (input.mandate_type === "intent") {
    if (input.parent_mandate_id) {
      errors.push("intent mandates must not have a parent");
    }
    const p = input.payload as IntentPayload;
    if (!p.description || typeof p.description !== "string" || !p.description.trim()) {
      errors.push("intent payload must include a non-empty description");
    }
  } else if (input.mandate_type === "cart") {
    if (!input.parent_mandate_id) {
      errors.push("cart mandates require a parent intent mandate");
      return errors;
    }
    const p = input.payload as CartPayload;
    if (!p.cart_id) errors.push("cart payload must include cart_id");
    if (!p.max_total) errors.push("cart payload must include max_total");

    // Validate parent is an active intent for same agent
    const { rows } = await pool.query<{ id: string; mandate_type: string; agent_id: string; is_active: boolean; revoked_at: Date | null; expires_at: Date | null }>(
      `SELECT id::text, mandate_type, agent_id::text, is_active, revoked_at, expires_at
       FROM mandates WHERE id = $1::uuid AND store_id = $2::uuid`,
      [input.parent_mandate_id, storeId]
    );
    const parent = rows[0];
    if (!parent) {
      errors.push("parent mandate not found");
    } else {
      if (parent.mandate_type !== "intent") errors.push("cart parent must be an intent mandate");
      if (parent.agent_id !== agentId) errors.push("parent mandate belongs to a different agent");
      if (!parent.is_active || parent.revoked_at) errors.push("parent intent mandate is inactive or revoked");
      if (parent.expires_at && parent.expires_at < new Date()) errors.push("parent intent mandate has expired");
    }
  } else if (input.mandate_type === "payment") {
    if (!input.parent_mandate_id) {
      errors.push("payment mandates require a parent cart mandate");
      return errors;
    }
    const p = input.payload as PaymentPayload;
    if (!p.checkout_id) errors.push("payment payload must include checkout_id");
    if (!p.amount) errors.push("payment payload must include amount");

    // Validate parent is an active cart for same agent
    const { rows } = await pool.query<{
      id: string;
      mandate_type: string;
      agent_id: string;
      is_active: boolean;
      revoked_at: Date | null;
      expires_at: Date | null;
      payload: CartPayload;
    }>(
      `SELECT id::text, mandate_type, agent_id::text, is_active, revoked_at, expires_at,
              payload
       FROM mandates WHERE id = $1::uuid AND store_id = $2::uuid`,
      [input.parent_mandate_id, storeId]
    );
    const parent = rows[0];
    if (!parent) {
      errors.push("parent mandate not found");
    } else {
      if (parent.mandate_type !== "cart") errors.push("payment parent must be a cart mandate");
      if (parent.agent_id !== agentId) errors.push("parent mandate belongs to a different agent");
      if (!parent.is_active || parent.revoked_at) errors.push("parent cart mandate is inactive or revoked");
      if (parent.expires_at && parent.expires_at < new Date()) errors.push("parent cart mandate has expired");

      // Amount consistency: payment amount must not exceed cart max_total
      if (p.amount && parent.payload?.max_total) {
        const payAmt = parseFloat(p.amount);
        const maxTotal = parseFloat(parent.payload.max_total);
        if (!isNaN(payAmt) && !isNaN(maxTotal) && payAmt > maxTotal) {
          errors.push(
            `payment amount ${p.amount} exceeds cart max_total ${parent.payload.max_total}`
          );
        }
      }
    }
  }

  return errors;
}

/**
 * Create a mandate.
 * If signature is provided it will be verified against the agent's public key.
 * Chain consistency rules are always enforced server-side.
 */
export async function createMandate(
  storeId: string,
  input: CreateMandateInput
): Promise<MandatePublic> {
  const pool = getPool();

  // Verify agent exists and is active
  const { rows: agentRows } = await pool.query<{ id: string; public_key: string | null; status: string }>(
    `SELECT id::text, public_key, status FROM agents
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [input.agent_id, storeId]
  );
  const agent = agentRows[0];
  if (!agent) {
    const err = new Error("agent not found") as NodeJS.ErrnoException;
    err.code = "NOT_FOUND";
    throw err;
  }
  if (agent.status !== "active") {
    const err = new Error("agent is not active") as NodeJS.ErrnoException;
    err.code = "AGENT_INACTIVE";
    throw err;
  }

  // Validate chain
  const chainErrors = await validateMandateChain(pool, input, input.agent_id, storeId);
  if (chainErrors.length > 0) {
    const err = new Error(chainErrors.join("; ")) as NodeJS.ErrnoException;
    err.code = "MANDATE_CHAIN_INVALID";
    throw err;
  }

  // Verify signature if provided (and agent has a public key)
  if (input.signature && agent.public_key) {
    // We verify after inserting the row (so we have the id) or against a pre-set id.
    // Instead, we require the caller to pre-compute the id and sign that. But for
    // simplicity in this AP2 chain, we verify using a placeholder id='pending' or
    // we verify after insert and rollback if invalid.
    // Practical approach: accept the signature claim, insert row, then verify.
    // If verification fails, we delete the row.
    // Alternatively, don't store the row until verified.
    // Design choice: verify by inserting with signature stored, then check.
    // We do this below after the insert.
  }

  const expiresAt = input.expires_at ?? null;
  const name = input.name ?? `${input.mandate_type}-${Date.now()}`;

  const { rows } = await pool.query<MandateRow>(
    `INSERT INTO mandates (
       agent_id, store_id, mandate_type, payload,
       parent_mandate_id, signature, signing_key,
       name, scopes, resource_type, resource_ids,
       rate_limit_rpm, valid_from, valid_until, expires_at,
       is_active, metadata
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::jsonb,
       $5::uuid, $6, $7,
       $8, $9, $10, $11::uuid[],
       $12, now(), $13, $14,
       true, $15::jsonb
     )
     RETURNING
       id::text, agent_id::text, store_id::text,
       mandate_type, payload, parent_mandate_id::text,
       signature, signing_key, name, scopes,
       resource_type, resource_ids::text[], rate_limit_rpm,
       valid_from, valid_until, expires_at,
       is_active, revoked_at, revoke_reason,
       metadata, created_at, updated_at`,
    [
      input.agent_id,
      storeId,
      input.mandate_type,
      JSON.stringify(input.payload),
      input.parent_mandate_id ?? null,
      input.signature ?? null,
      agent.public_key ?? null,
      name,
      input.scopes ?? [],
      input.resource_type ?? null,
      input.resource_ids ?? [],
      input.rate_limit_rpm ?? null,
      expiresAt,
      expiresAt,
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  const row = rows[0]!;

  // Verify signature post-insert (we now have the row id)
  if (input.signature && agent.public_key) {
    const valid = verifyMandateSignature(
      {
        id: row.id,
        agent_id: row.agent_id,
        store_id: row.store_id,
        mandate_type: row.mandate_type,
        payload: row.payload,
        parent_mandate_id: row.parent_mandate_id,
        expires_at: row.expires_at?.toISOString() ?? null,
      },
      input.signature,
      agent.public_key
    );
    if (!valid) {
      // Remove the row we just inserted
      await pool.query(`DELETE FROM mandates WHERE id = $1::uuid`, [row.id]);
      const err = new Error("mandate signature verification failed") as NodeJS.ErrnoException;
      err.code = "SIGNATURE_INVALID";
      throw err;
    }
  }

  return mandateToPublic(row);
}

// ── Mandate verify ────────────────────────────────────────────────────────────

/**
 * Verify a mandate and its full chain.
 *
 * Checks:
 *  1. Mandate exists and is active
 *  2. Agent exists, is active
 *  3. Signature valid against agent's public key (if present)
 *  4. Not expired
 *  5. Full chain (payment→cart→intent): each link valid
 *  6. Payload consistency across chain (payment amount <= cart max_total)
 */
export async function verifyMandate(
  storeId: string,
  mandateId: string
): Promise<MandateVerifyResult> {
  const pool = getPool();
  const errors: string[] = [];
  const chain: MandatePublic[] = [];

  // Load the mandate
  const { rows: mRows } = await pool.query<MandateRow>(
    `SELECT
       id::text, agent_id::text, store_id::text,
       mandate_type, payload, parent_mandate_id::text,
       signature, signing_key, name, scopes,
       resource_type, resource_ids::text[], rate_limit_rpm,
       valid_from, valid_until, expires_at,
       is_active, revoked_at, revoke_reason,
       metadata, created_at, updated_at
     FROM mandates
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [mandateId, storeId]
  );
  const mandate = mRows[0];
  if (!mandate) {
    return { valid: false, mandate: null, chain: [], errors: ["mandate not found"] };
  }

  chain.push(mandateToPublic(mandate));

  // Check revocation
  if (!mandate.is_active || mandate.revoked_at) {
    errors.push("mandate is revoked or inactive");
  }

  // Check expiry
  if (mandate.expires_at && mandate.expires_at < new Date()) {
    errors.push("mandate has expired");
  }

  // Load agent
  const { rows: agentRows } = await pool.query<{
    id: string;
    public_key: string | null;
    status: string;
  }>(
    `SELECT id::text, public_key, status FROM agents
     WHERE id = $1::uuid`,
    [mandate.agent_id]
  );
  const agent = agentRows[0];
  if (!agent) {
    errors.push("agent not found");
  } else {
    if (agent.status !== "active") {
      errors.push(`agent is ${agent.status}`);
    }

    // Verify signature
    if (mandate.signature && agent.public_key) {
      const valid = verifyMandateSignature(
        {
          id: mandate.id,
          agent_id: mandate.agent_id,
          store_id: mandate.store_id,
          mandate_type: mandate.mandate_type,
          payload: mandate.payload,
          parent_mandate_id: mandate.parent_mandate_id,
          expires_at: mandate.expires_at?.toISOString() ?? null,
        },
        mandate.signature,
        agent.public_key
      );
      if (!valid) {
        errors.push("mandate signature is invalid");
      }
    }
  }

  // Walk the chain upward
  let current: MandateRow = mandate;
  let depth = 0;
  while (current.parent_mandate_id && depth < 3) {
    depth++;
    const { rows: parentRows } = await pool.query<MandateRow>(
      `SELECT
         id::text, agent_id::text, store_id::text,
         mandate_type, payload, parent_mandate_id::text,
         signature, signing_key, name, scopes,
         resource_type, resource_ids::text[], rate_limit_rpm,
         valid_from, valid_until, expires_at,
         is_active, revoked_at, revoke_reason,
         metadata, created_at, updated_at
       FROM mandates WHERE id = $1::uuid`,
      [current.parent_mandate_id]
    );
    const parent = parentRows[0];
    if (!parent) {
      errors.push(`parent mandate ${current.parent_mandate_id} not found`);
      break;
    }
    chain.push(mandateToPublic(parent));

    // Parent must belong to same agent and store
    if (parent.agent_id !== mandate.agent_id) {
      errors.push("chain parent belongs to different agent");
    }
    if (parent.store_id !== mandate.store_id) {
      errors.push("chain parent belongs to different store");
    }

    // Parent must be active
    if (!parent.is_active || parent.revoked_at) {
      errors.push(`parent mandate (${parent.mandate_type}) is revoked or inactive`);
    }

    // Parent must not be expired
    if (parent.expires_at && parent.expires_at < new Date()) {
      errors.push(`parent mandate (${parent.mandate_type}) has expired`);
    }

    // Verify parent signature
    if (parent.signature && agent?.public_key) {
      const parentSigValid = verifyMandateSignature(
        {
          id: parent.id,
          agent_id: parent.agent_id,
          store_id: parent.store_id,
          mandate_type: parent.mandate_type,
          payload: parent.payload,
          parent_mandate_id: parent.parent_mandate_id,
          expires_at: parent.expires_at?.toISOString() ?? null,
        },
        parent.signature,
        agent.public_key
      );
      if (!parentSigValid) {
        errors.push(`parent mandate (${parent.mandate_type}) signature is invalid`);
      }
    }

    current = parent;
  }

  // Validate expected chain shape
  if (mandate.mandate_type === "payment") {
    const cartMandate = chain[1];
    const intentMandate = chain[2];
    if (!cartMandate || cartMandate.mandate_type !== "cart") {
      errors.push("payment mandate chain: cart parent required");
    }
    if (!intentMandate || intentMandate.mandate_type !== "intent") {
      errors.push("payment mandate chain: intent grandparent required");
    }
    // Amount consistency
    if (cartMandate && cartMandate.mandate_type === "cart") {
      const payPayload = mandate.payload as PaymentPayload;
      const cartPayload = cartMandate.payload as CartPayload;
      if (payPayload.amount && cartPayload.max_total) {
        const payAmt = parseFloat(payPayload.amount);
        const maxTotal = parseFloat(cartPayload.max_total);
        if (!isNaN(payAmt) && !isNaN(maxTotal) && payAmt > maxTotal) {
          errors.push(
            `payment amount ${payPayload.amount} exceeds cart max_total ${cartPayload.max_total}`
          );
        }
      }
    }
  } else if (mandate.mandate_type === "cart") {
    const intentMandate = chain[1];
    if (!intentMandate || intentMandate.mandate_type !== "intent") {
      errors.push("cart mandate chain: intent parent required");
    }
  }

  return {
    valid: errors.length === 0,
    mandate: mandateToPublic(mandate),
    chain,
    errors,
  };
}

/** List mandates for an agent. */
export async function listMandates(
  storeId: string,
  agentId: string,
  opts: { limit?: number; offset?: number; type?: string; active?: boolean } = {}
): Promise<MandatePublic[]> {
  const pool = getPool();
  const conditions = ["store_id = $1::uuid", "agent_id = $2::uuid"];
  const vals: unknown[] = [storeId, agentId];
  let i = 3;

  if (opts.type) {
    conditions.push(`mandate_type = $${i++}`);
    vals.push(opts.type);
  }
  if (opts.active !== undefined) {
    conditions.push(`is_active = $${i++}`);
    vals.push(opts.active);
  }

  vals.push(opts.limit ?? 50);
  vals.push(opts.offset ?? 0);

  const { rows } = await pool.query<MandateRow>(
    `SELECT
       id::text, agent_id::text, store_id::text,
       mandate_type, payload, parent_mandate_id::text,
       signature, signing_key, name, scopes,
       resource_type, resource_ids::text[], rate_limit_rpm,
       valid_from, valid_until, expires_at,
       is_active, revoked_at, revoke_reason,
       metadata, created_at, updated_at
     FROM mandates
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    vals
  );
  return rows.map(mandateToPublic);
}

/** Revoke a mandate. */
export async function revokeMandate(
  storeId: string,
  mandateId: string,
  reason?: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE mandates
     SET is_active = false, revoked_at = now(), revoke_reason = $3
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [mandateId, storeId, reason ?? null]
  );
  return (rowCount ?? 0) > 0;
}

// ── Audit log ─────────────────────────────────────────────────────────────────

/** Insert an audit log row. Fire-and-forget safe. */
export async function insertAuditLog(input: InsertAuditLogInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_audit_log (
       agent_id, mandate_id, store_id,
       action, resource_type, resource_id,
       request_payload, response_payload,
       status, error_message, duration_ms,
       ip_address, correlation_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4, $5, $6::uuid,
       $7::jsonb, $8::jsonb,
       $9, $10, $11,
       $12::inet, $13
     )`,
    [
      input.agent_id,
      input.mandate_id ?? null,
      input.store_id,
      input.action,
      input.resource_type ?? null,
      input.resource_id ?? null,
      JSON.stringify(input.request_payload ?? {}),
      JSON.stringify(input.response_payload ?? {}),
      input.status ?? "success",
      input.error_message ?? null,
      input.duration_ms ?? null,
      input.ip_address ?? null,
      input.correlation_id ?? null,
    ]
  );
}

/** List audit log entries for a store. */
export async function listAuditLog(
  storeId: string,
  opts: {
    agentId?: string;
    limit?: number;
    offset?: number;
    status?: string;
  } = {}
): Promise<AuditLogPublic[]> {
  const pool = getPool();
  const conditions = ["store_id = $1::uuid"];
  const vals: unknown[] = [storeId];
  let i = 2;

  if (opts.agentId) {
    conditions.push(`agent_id = $${i++}::uuid`);
    vals.push(opts.agentId);
  }
  if (opts.status) {
    conditions.push(`status = $${i++}`);
    vals.push(opts.status);
  }

  vals.push(opts.limit ?? 50);
  vals.push(opts.offset ?? 0);

  const { rows } = await pool.query<{
    id: string;
    agent_id: string;
    mandate_id: string | null;
    store_id: string;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    request_payload: Record<string, unknown>;
    response_payload: Record<string, unknown>;
    status: string;
    error_message: string | null;
    duration_ms: number | null;
    ip_address: string | null;
    correlation_id: string | null;
    created_at: Date;
  }>(
    `SELECT
       id::text, agent_id::text, mandate_id::text, store_id::text,
       action, resource_type, resource_id::text,
       request_payload, response_payload,
       status, error_message, duration_ms,
       ip_address::text, correlation_id, created_at
     FROM agent_audit_log
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    vals
  );

  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id,
    mandate_id: r.mandate_id,
    store_id: r.store_id,
    action: r.action,
    resource_type: r.resource_type,
    resource_id: r.resource_id,
    request_payload: r.request_payload,
    response_payload: r.response_payload,
    status: r.status as import("./types.js").AuditLogStatus,
    error_message: r.error_message,
    duration_ms: r.duration_ms,
    ip_address: r.ip_address,
    correlation_id: r.correlation_id,
    created_at: r.created_at.toISOString(),
  }));
}

// ── Spend enforcement ─────────────────────────────────────────────────────────

/**
 * Verify that an agent checkout is within the agent's spend limit and, when the
 * store flag `agents_require_mandate` is set, that a valid mandate chain exists.
 *
 * Algorithm:
 *  1. Load agent (must be active)
 *  2. If agent has spend_limit + spend_window:
 *     - Sum order totals for orders attributed to this agent within the window
 *     - If sum + checkoutTotal > spend_limit → reject with MANDATE_SPEND_LIMIT_EXCEEDED
 *  3a. If storeRequiresMandate = true:
 *      - Must find an active payment mandate for checkout_id, and the chain
 *        must verify. Absence or invalidity → MANDATE_REQUIRED.
 *  3b. If storeRequiresMandate = false (default):
 *      - If a payment mandate exists for checkout_id → verify the chain.
 *        Invalidity → MANDATE_REQUIRED. Absence → OK (spend-limit-only mode).
 *
 * @param storeRequiresMandate  Pass the store's agents_require_mandate flag.
 *
 * @throws Error with code MANDATE_SPEND_LIMIT_EXCEEDED if limit exceeded
 * @throws Error with code AGENT_INACTIVE if agent is disabled
 * @throws Error with code MANDATE_REQUIRED if mandate required but missing/invalid
 */
export async function verifyAgentCheckout(
  agentId: string,
  storeId: string,
  checkoutId: string,
  checkoutTotal: number,
  storeRequiresMandate = false
): Promise<void> {
  const pool = getPool();

  // 1. Load agent
  const agent = await getAgentById(agentId);
  if (!agent) {
    const err = new Error("agent not found") as NodeJS.ErrnoException;
    err.code = "AGENT_NOT_FOUND";
    throw err;
  }
  if (agent.status !== "active") {
    const err = new Error(`agent is ${agent.status}`) as NodeJS.ErrnoException;
    err.code = "AGENT_INACTIVE";
    throw err;
  }

  // 2. Spend limit check
  if (agent.spend_limit !== null && agent.spend_window) {
    const windowInterval = parseSpendWindow(agent.spend_window);
    const { rows: spendRows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(o.total), 0)::text AS total
       FROM orders o
       WHERE o.store_id = $1::uuid
         AND o.metadata->>'agent_id' = $2
         AND o.created_at >= now() - $3::interval
         AND o.financial_status NOT IN ('voided', 'refunded')`,
      [storeId, agentId, windowInterval]
    );
    const alreadySpent = parseFloat(spendRows[0]?.total ?? "0");
    const spendLimit = parseFloat(agent.spend_limit);

    if (alreadySpent + checkoutTotal > spendLimit) {
      const err = new Error(
        `agent spend limit exceeded: ${alreadySpent + checkoutTotal} > ${spendLimit} within ${agent.spend_window}`
      ) as NodeJS.ErrnoException;
      err.code = "MANDATE_SPEND_LIMIT_EXCEEDED";
      throw err;
    }
  }

  // 3. Payment mandate check
  const { rows: mandateRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM mandates
     WHERE store_id = $1::uuid
       AND agent_id = $2::uuid
       AND mandate_type = 'payment'
       AND is_active = true
       AND revoked_at IS NULL
       AND payload->>'checkout_id' = $3
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [storeId, agentId, checkoutId]
  );

  if (mandateRows.length > 0) {
    // Mandate exists — verify the full chain regardless of store flag.
    const result = await verifyMandate(storeId, mandateRows[0]!.id);
    if (!result.valid) {
      const err = new Error(
        `payment mandate invalid: ${result.errors.join("; ")}`
      ) as NodeJS.ErrnoException;
      err.code = "MANDATE_REQUIRED";
      throw err;
    }
  } else if (storeRequiresMandate) {
    // Store requires a mandate but none was found for this checkout.
    const err = new Error(
      `store requires a valid payment mandate for agent checkout, but none found for checkout ${checkoutId}`
    ) as NodeJS.ErrnoException;
    err.code = "MANDATE_REQUIRED";
    throw err;
  }
}
