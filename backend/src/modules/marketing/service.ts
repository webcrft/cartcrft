/**
 * marketing/service.ts — Event-triggered marketing flows (drip sequences).
 *
 * Responsibilities:
 *   1. Flow CRUD (store-scoped; validates step shape, action enum, delay >= 0).
 *   2. enrollFlow — idempotent insertion of a marketing_flow_run for a
 *      (flow, trigger_ref) pair (ON CONFLICT DO NOTHING).
 *   3. processDueRuns — the worker tick: select active runs due at `now`
 *      (FOR UPDATE SKIP LOCKED), execute the current step's email/SMS action via
 *      INJECTED senders, advance current_step (or complete), with a bounded
 *      retry policy on send failure.
 *   4. Trigger discovery — poll for newly-eligible entities (orders / customers /
 *      abandoned carts) and enroll them into matching active flows. Idempotency
 *      is guaranteed by unique(flow_id, trigger_ref).
 *
 * Like recovery/service.ts, the worker-facing functions run on the owner
 * connection (getPool().query) — i.e. cross-store, BYPASSRLS — which is required
 * because background jobs have no per-request tenant context. The store_id is
 * always carried explicitly on every row so isolation is preserved logically.
 *
 * Senders are injectable (ProcessDeps) so tests never hit real providers.
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { getPool } from "../../db/pool.js";
import { config } from "../../config/config.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { newTwilioClient, type TwilioClient } from "../../providers/notifications/twilio.js";
import type {
  CreateFlowInput,
  FlowAction,
  FlowStep,
  MarketingFlow,
  MarketingFlowRun,
  TriggerEvent,
  UpdateFlowInput,
} from "./types.js";
import { FLOW_ACTIONS, TRIGGER_EVENTS } from "./types.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Send attempts per step before the run is marked failed. */
export const MAX_FLOW_SEND_ATTEMPTS = 3;

/** Max active runs processed in one worker tick (batch size). */
export const DEFAULT_PROCESS_BATCH = 100;

/** Lookback window for trigger discovery (defends against clock skew / gaps). */
export const DEFAULT_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Injectable senders ──────────────────────────────────────────────────────

/** Abstraction over SMS delivery so tests can stub it (no real Twilio). */
export interface SmsSender {
  sendSms(params: { to: string; body: string }): Promise<void>;
}

/**
 * Build an SmsSender from env config (mirrors notifications buildSmsProviderFromConfig).
 * Returns null when Twilio is not configured.
 */
export function buildSmsSenderFromConfig(): SmsSender | null {
  if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN) {
    const client: TwilioClient = newTwilioClient({
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      fromNumber: config.TWILIO_FROM_NUMBER,
      messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
    });
    return {
      async sendSms(params) {
        await client.sendSms(params);
      },
    };
  }
  return null;
}

/** Dependencies injected into processDueRuns (and the worker). */
export interface ProcessDeps {
  /** Required for email-action steps. */
  mailer: Mailer;
  /** Optional; email-only flows can omit it. SMS steps fail without it. */
  sms?: SmsSender | null;
  clock?: Clock;
  /** Max runs to process this tick. Default DEFAULT_PROCESS_BATCH. */
  batch?: number;
}

// ── Validation ──────────────────────────────────────────────────────────────

export class FlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowValidationError";
    (this as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
  }
}

function isTriggerEvent(v: unknown): v is TriggerEvent {
  return typeof v === "string" && (TRIGGER_EVENTS as readonly string[]).includes(v);
}

function isFlowAction(v: unknown): v is FlowAction {
  return typeof v === "string" && (FLOW_ACTIONS as readonly string[]).includes(v);
}

/**
 * Validate + normalise the steps array. Throws FlowValidationError on any
 * malformed step. Returns a clean FlowStep[] safe to persist.
 */
export function validateSteps(raw: unknown): FlowStep[] {
  if (!Array.isArray(raw)) {
    throw new FlowValidationError("steps must be an array");
  }
  if (raw.length === 0) {
    throw new FlowValidationError("steps must contain at least one step");
  }
  if (raw.length > 50) {
    throw new FlowValidationError("steps may contain at most 50 entries");
  }

  const out: FlowStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown>;
    if (typeof s !== "object" || s === null) {
      throw new FlowValidationError(`step[${i}] must be an object`);
    }

    const delay = s["delay_seconds"];
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 0) {
      throw new FlowValidationError(`step[${i}].delay_seconds must be an integer >= 0`);
    }

    const action = s["action"];
    if (!isFlowAction(action)) {
      throw new FlowValidationError(`step[${i}].action must be one of: ${FLOW_ACTIONS.join(", ")}`);
    }

    const body = s["body"];
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new FlowValidationError(`step[${i}].body is required (non-empty string)`);
    }
    if (body.length > 16384) {
      throw new FlowValidationError(`step[${i}].body is too long (max 16384 chars)`);
    }

    let subject: string | null = null;
    const rawSubject = s["subject"];
    if (rawSubject !== undefined && rawSubject !== null) {
      if (typeof rawSubject !== "string") {
        throw new FlowValidationError(`step[${i}].subject must be a string or null`);
      }
      if (rawSubject.length > 500) {
        throw new FlowValidationError(`step[${i}].subject is too long (max 500 chars)`);
      }
      subject = rawSubject;
    }
    if (action === "email" && (subject === null || subject.trim().length === 0)) {
      throw new FlowValidationError(`step[${i}].subject is required for email steps`);
    }

    out.push({ delay_seconds: delay, action, subject, body });
  }
  return out;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

interface RawFlowRow {
  id: string;
  store_id: string;
  name: string;
  trigger_event: TriggerEvent;
  is_active: boolean;
  steps: unknown;
  created_at: string;
  updated_at: string;
}

function mapFlow(r: RawFlowRow): MarketingFlow {
  const steps = Array.isArray(r.steps) ? (r.steps as FlowStep[]) : [];
  return {
    id: r.id,
    store_id: r.store_id,
    name: r.name,
    trigger_event: r.trigger_event,
    is_active: r.is_active,
    steps,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const FLOW_COLS = `
  id::text, store_id::text, name, trigger_event, is_active,
  steps, created_at, updated_at
`;

const RUN_COLS = `
  id::text, store_id::text, flow_id::text, customer_id::text,
  trigger_ref, current_step, status, next_run_at, attempts, last_error,
  created_at, updated_at
`;

// ── Flow CRUD ──────────────────────────────────────────────────────────────

export async function listFlows(storeId: string): Promise<MarketingFlow[]> {
  const pool = getPool();
  const { rows } = await pool.query<RawFlowRow>(
    `SELECT ${FLOW_COLS} FROM marketing_flows
     WHERE store_id = $1::uuid
     ORDER BY created_at DESC`,
    [storeId]
  );
  return rows.map(mapFlow);
}

export async function getFlow(storeId: string, flowId: string): Promise<MarketingFlow | null> {
  const pool = getPool();
  const { rows } = await pool.query<RawFlowRow>(
    `SELECT ${FLOW_COLS} FROM marketing_flows
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [flowId, storeId]
  );
  return rows[0] ? mapFlow(rows[0]) : null;
}

export async function createFlow(
  storeId: string,
  input: CreateFlowInput
): Promise<MarketingFlow> {
  const name = (input.name ?? "").trim();
  if (!name) throw new FlowValidationError("name is required");
  if (name.length > 200) throw new FlowValidationError("name is too long (max 200 chars)");
  if (!isTriggerEvent(input.trigger_event)) {
    throw new FlowValidationError(`trigger_event must be one of: ${TRIGGER_EVENTS.join(", ")}`);
  }
  const steps = validateSteps(input.steps);
  const isActive = input.is_active ?? true;

  const pool = getPool();
  const { rows } = await pool.query<RawFlowRow>(
    `INSERT INTO marketing_flows (store_id, name, trigger_event, is_active, steps)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
     RETURNING ${FLOW_COLS}`,
    [storeId, name, input.trigger_event, isActive, JSON.stringify(steps)]
  );
  const row = rows[0];
  if (!row) throw new Error("createFlow: no row returned");
  return mapFlow(row);
}

export async function updateFlow(
  storeId: string,
  flowId: string,
  input: UpdateFlowInput
): Promise<MarketingFlow | null> {
  const sets: string[] = [];
  const args: unknown[] = [flowId, storeId];
  let n = 3;

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new FlowValidationError("name cannot be empty");
    if (name.length > 200) throw new FlowValidationError("name is too long (max 200 chars)");
    sets.push(`name = $${n++}`);
    args.push(name);
  }
  if (input.trigger_event !== undefined) {
    if (!isTriggerEvent(input.trigger_event)) {
      throw new FlowValidationError(`trigger_event must be one of: ${TRIGGER_EVENTS.join(", ")}`);
    }
    sets.push(`trigger_event = $${n++}`);
    args.push(input.trigger_event);
  }
  if (input.steps !== undefined) {
    const steps = validateSteps(input.steps);
    sets.push(`steps = $${n++}::jsonb`);
    args.push(JSON.stringify(steps));
  }
  if (input.is_active !== undefined) {
    sets.push(`is_active = $${n++}`);
    args.push(input.is_active);
  }

  if (sets.length === 0) throw new FlowValidationError("nothing to update");
  sets.push("updated_at = now()");

  const pool = getPool();
  const { rows } = await pool.query<RawFlowRow>(
    `UPDATE marketing_flows SET ${sets.join(", ")}
     WHERE id = $1::uuid AND store_id = $2::uuid
     RETURNING ${FLOW_COLS}`,
    args
  );
  return rows[0] ? mapFlow(rows[0]) : null;
}

export async function deleteFlow(storeId: string, flowId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM marketing_flows WHERE id = $1::uuid AND store_id = $2::uuid`,
    [flowId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Flow runs (read) ──────────────────────────────────────────────────────────

interface RawRunRow {
  id: string;
  store_id: string;
  flow_id: string;
  customer_id: string | null;
  trigger_ref: string;
  current_step: number;
  status: MarketingFlowRun["status"];
  next_run_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function listRuns(
  storeId: string,
  opts: { flowId?: string; limit?: number; offset?: number } = {}
): Promise<MarketingFlowRun[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const args: unknown[] = [storeId];
  let where = `store_id = $1::uuid`;
  if (opts.flowId) {
    args.push(opts.flowId);
    where += ` AND flow_id = $${args.length}::uuid`;
  }
  args.push(limit, offset);
  const { rows } = await pool.query<RawRunRow>(
    `SELECT ${RUN_COLS} FROM marketing_flow_runs
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return rows as MarketingFlowRun[];
}

// ── Enrollment (idempotent) ────────────────────────────────────────────────────

/**
 * enrollFlow — insert a marketing_flow_run for (flow, trigger_ref), idempotent
 * via ON CONFLICT(flow_id, trigger_ref) DO NOTHING. next_run_at is set to
 * now + steps[0].delay_seconds. Returns the new run id, or null if the run
 * already existed (idempotent skip) or the flow has no steps.
 */
export async function enrollFlow(
  storeId: string,
  flow: Pick<MarketingFlow, "id" | "steps">,
  customerId: string | null,
  triggerRef: string,
  now: Date
): Promise<string | null> {
  const firstStep = flow.steps[0];
  if (!firstStep) return null;

  const nextRunAt = new Date(now.getTime() + firstStep.delay_seconds * 1000);

  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO marketing_flow_runs
       (store_id, flow_id, customer_id, trigger_ref, current_step, status, next_run_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 0, 'active', $5)
     ON CONFLICT (flow_id, trigger_ref) DO NOTHING
     RETURNING id::text`,
    [storeId, flow.id, customerId, triggerRef, nextRunAt]
  );
  return rows[0]?.id ?? null;
}

// ── Worker tick: process due runs ───────────────────────────────────────────

interface DueRun {
  id: string;
  store_id: string;
  flow_id: string;
  customer_id: string | null;
  current_step: number;
  attempts: number;
  steps: FlowStep[];
}

/**
 * processDueRuns — execute the current step of every active run that is due at
 * `now`. Each run is claimed FOR UPDATE SKIP LOCKED inside its own transaction
 * so concurrent workers never double-send the same step. Senders are injected
 * via `deps`.
 *
 * For each claimed run:
 *   - resolve recipient (customer email/phone),
 *   - send the step's action,
 *   - on success: advance current_step → next step's next_run_at, or complete,
 *   - on failure: bump attempts + record last_error; after MAX attempts, fail.
 *
 * Returns the number of steps successfully sent.
 *
 * @param storeId optional — when provided, only that store's runs are processed.
 */
export async function processDueRuns(
  storeId: string | null,
  deps: ProcessDeps
): Promise<number> {
  const clock = deps.clock ?? new SystemClock();
  const now = clock.now();
  const batch = deps.batch ?? DEFAULT_PROCESS_BATCH;
  const pool = getPool();

  // Claim due run ids (lightweight) so each run is handled in its own tx.
  const claimArgs: unknown[] = [now, batch];
  let claimWhere = `r.status = 'active' AND r.next_run_at IS NOT NULL AND r.next_run_at <= $1`;
  if (storeId) {
    claimArgs.push(storeId);
    claimWhere += ` AND r.store_id = $${claimArgs.length}::uuid`;
  }
  const { rows: dueIds } = await pool.query<{ id: string }>(
    `SELECT r.id::text
     FROM marketing_flow_runs r
     WHERE ${claimWhere}
     ORDER BY r.next_run_at
     LIMIT $2`,
    claimArgs
  );

  let sent = 0;
  for (const { id } of dueIds) {
    try {
      const ok = await processOneRun(id, now, deps);
      if (ok) sent++;
    } catch (err) {
      console.error(`[marketing] error processing run ${id}:`, err);
      if (process.env["APP_ENV"] === "test") throw err;
    }
  }
  return sent;
}

/**
 * processOneRun — claim a single run FOR UPDATE SKIP LOCKED, execute its step,
 * and advance. Returns true if a message was sent.
 */
async function processOneRun(runId: string, now: Date, deps: ProcessDeps): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Claim the run; SKIP LOCKED so a sibling worker holding it won't block us.
    const { rows: runRows } = await client.query<DueRun>(
      `SELECT r.id::text, r.store_id::text, r.flow_id::text, r.customer_id::text,
              r.current_step, r.attempts, f.steps
       FROM marketing_flow_runs r
       JOIN marketing_flows f ON f.id = r.flow_id
       WHERE r.id = $1::uuid
         AND r.status = 'active'
         AND r.next_run_at IS NOT NULL
         AND r.next_run_at <= $2
       FOR UPDATE OF r SKIP LOCKED`,
      [runId, now]
    );
    const run = runRows[0];
    if (!run) {
      // Already handled by another worker, or no longer due.
      await client.query("ROLLBACK");
      return false;
    }

    const steps: FlowStep[] = Array.isArray(run.steps) ? (run.steps as FlowStep[]) : [];
    const step = steps[run.current_step];

    // Step out of range (flow edited after enrollment) → complete the run.
    if (!step) {
      await client.query(
        `UPDATE marketing_flow_runs
         SET status = 'completed', next_run_at = NULL, updated_at = now()
         WHERE id = $1::uuid`,
        [run.id]
      );
      await client.query("COMMIT");
      return false;
    }

    // Resolve the recipient for this action.
    const recipient = await resolveRecipient(client, run.store_id, run.customer_id, step.action);

    if (!recipient) {
      // No contact for this channel — skip the step (advance) rather than retry
      // forever. Record the reason for visibility.
      await advanceRun(client, run.id, run.current_step, steps, now, "no recipient contact for channel");
      await client.query("COMMIT");
      return false;
    }

    // Attempt the send.
    try {
      await sendStep(deps, step, recipient);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = run.attempts + 1;
      if (attempts >= MAX_FLOW_SEND_ATTEMPTS) {
        await client.query(
          `UPDATE marketing_flow_runs
           SET status = 'failed', attempts = $2, last_error = $3, next_run_at = NULL, updated_at = now()
           WHERE id = $1::uuid`,
          [run.id, attempts, message.slice(0, 1000)]
        );
      } else {
        // Leave next_run_at in the past so the next tick retries this step.
        await client.query(
          `UPDATE marketing_flow_runs
           SET attempts = $2, last_error = $3, updated_at = now()
           WHERE id = $1::uuid`,
          [run.id, attempts, message.slice(0, 1000)]
        );
      }
      await client.query("COMMIT");
      return false;
    }

    // Sent — advance to the next step or complete.
    await advanceRun(client, run.id, run.current_step, steps, now, null);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* best-effort */ });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * advanceRun — move the run to the next step (resetting attempts) or complete it.
 * `note` (when set) is recorded in last_error for skipped steps (non-fatal).
 */
async function advanceRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg.PoolClient
  client: any,
  runId: string,
  currentStep: number,
  steps: FlowStep[],
  now: Date,
  note: string | null
): Promise<void> {
  const nextIndex = currentStep + 1;
  const nextStep = steps[nextIndex];
  if (nextStep) {
    const nextRunAt = new Date(now.getTime() + nextStep.delay_seconds * 1000);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await client.query(
      `UPDATE marketing_flow_runs
       SET current_step = $2, next_run_at = $3, attempts = 0, last_error = $4, updated_at = now()
       WHERE id = $1::uuid`,
      [runId, nextIndex, nextRunAt, note]
    );
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    await client.query(
      `UPDATE marketing_flow_runs
       SET status = 'completed', current_step = $2, next_run_at = NULL, last_error = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [runId, nextIndex, note]
    );
  }
}

interface Recipient {
  email: string | null;
  phone: string | null;
}

/** Resolve a customer's email/phone for the step's channel. */
async function resolveRecipient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg.PoolClient
  client: any,
  storeId: string,
  customerId: string | null,
  action: FlowAction
): Promise<{ to: string } | null> {
  if (!customerId) return null;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const { rows } = await client.query(
    `SELECT email, phone FROM customers
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [customerId, storeId]
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const row = (rows[0] ?? null) as Recipient | null;
  if (!row) return null;
  if (action === "email") return row.email ? { to: row.email } : null;
  return row.phone ? { to: row.phone } : null;
}

/** Send a single step via the injected sender for its channel. */
async function sendStep(deps: ProcessDeps, step: FlowStep, recipient: { to: string }): Promise<void> {
  if (step.action === "email") {
    const fromEmail = config.EMAIL_FROM ?? "hello@cartcrft.dev";
    const bodyText = step.body;
    const bodyHtml = `<div>${escapeHtml(step.body).replace(/\n/g, "<br>")}</div>`;
    await deps.mailer.send({
      to: recipient.to,
      fromName: "CartCrft",
      fromEmail,
      subject: step.subject ?? "",
      bodyHtml,
      bodyText,
    });
  } else {
    if (!deps.sms) {
      throw new Error("SMS step but no SMS sender configured");
    }
    await deps.sms.sendSms({ to: recipient.to, body: step.body });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Trigger discovery (polling) ─────────────────────────────────────────────

/**
 * discoverAndEnroll — for every active flow in the system (or one store), find
 * newly-eligible trigger entities within the lookback window and enroll them.
 *
 * Idempotency: unique(flow_id, trigger_ref) means re-scanning the same window is
 * safe — already-enrolled (flow, ref) pairs are skipped by ON CONFLICT.
 *
 * trigger_ref:
 *   - order_created    → orders.id
 *   - customer_created → customers.id
 *   - abandoned_cart   → carts.id
 *
 * Returns the number of NEW runs enrolled.
 */
export async function discoverAndEnroll(
  storeId: string | null,
  opts: { clock?: Clock; windowMs?: number; abandonedThresholdMs?: number } = {}
): Promise<number> {
  const clock = opts.clock ?? new SystemClock();
  const now = clock.now();
  const windowMs = opts.windowMs ?? DEFAULT_DISCOVERY_WINDOW_MS;
  const since = new Date(now.getTime() - windowMs);
  const pool = getPool();

  // Load active flows (optionally scoped to one store).
  const flowArgs: unknown[] = [];
  let flowWhere = `is_active = true`;
  if (storeId) {
    flowArgs.push(storeId);
    flowWhere += ` AND store_id = $${flowArgs.length}::uuid`;
  }
  const { rows: flows } = await pool.query<RawFlowRow>(
    `SELECT ${FLOW_COLS} FROM marketing_flows WHERE ${flowWhere}`,
    flowArgs
  );

  let enrolled = 0;
  for (const raw of flows) {
    const flow = mapFlow(raw);
    if (flow.steps.length === 0) continue;
    try {
      switch (flow.trigger_event) {
        case "order_created":
          enrolled += await enrollOrders(flow, since, now);
          break;
        case "customer_created":
          enrolled += await enrollCustomers(flow, since, now);
          break;
        case "abandoned_cart":
          enrolled += await enrollAbandonedCarts(flow, since, now, opts.abandonedThresholdMs);
          break;
      }
    } catch (err) {
      console.error(`[marketing] discovery error for flow ${flow.id}:`, err);
      if (process.env["APP_ENV"] === "test") throw err;
    }
  }
  return enrolled;
}

async function enrollOrders(flow: MarketingFlow, since: Date, now: Date): Promise<number> {
  const pool = getPool();
  // New orders for this flow's store within the window that aren't yet enrolled.
  const { rows } = await pool.query<{ order_id: string; customer_id: string | null }>(
    `SELECT o.id::text AS order_id, o.customer_id::text AS customer_id
     FROM orders o
     WHERE o.store_id = $1::uuid
       AND o.created_at >= $2
       AND o.customer_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM marketing_flow_runs r
         WHERE r.flow_id = $3::uuid AND r.trigger_ref = o.id::text
       )`,
    [flow.store_id, since, flow.id]
  );
  let n = 0;
  for (const row of rows) {
    const id = await enrollFlow(flow.store_id, flow, row.customer_id, row.order_id, now);
    if (id) n++;
  }
  return n;
}

async function enrollCustomers(flow: MarketingFlow, since: Date, now: Date): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ customer_id: string }>(
    `SELECT c.id::text AS customer_id
     FROM customers c
     WHERE c.store_id = $1::uuid
       AND c.created_at >= $2
       AND NOT EXISTS (
         SELECT 1 FROM marketing_flow_runs r
         WHERE r.flow_id = $3::uuid AND r.trigger_ref = c.id::text
       )`,
    [flow.store_id, since, flow.id]
  );
  let n = 0;
  for (const row of rows) {
    const id = await enrollFlow(flow.store_id, flow, row.customer_id, row.customer_id, now);
    if (id) n++;
  }
  return n;
}

async function enrollAbandonedCarts(
  flow: MarketingFlow,
  since: Date,
  now: Date,
  abandonedThresholdMs?: number
): Promise<number> {
  const pool = getPool();
  const threshold = abandonedThresholdMs ?? 60 * 60 * 1000; // 1 hour default
  const cutoff = new Date(now.getTime() - threshold);
  // Carts that are active, older than the abandonment threshold, attached to a
  // customer, created within the discovery window, and not yet enrolled.
  const { rows } = await pool.query<{ cart_id: string; customer_id: string | null }>(
    `SELECT c.id::text AS cart_id, c.customer_id::text AS customer_id
     FROM carts c
     WHERE c.store_id = $1::uuid
       AND c.status = 'active'
       AND c.customer_id IS NOT NULL
       AND c.updated_at < $2
       AND c.created_at >= $3
       AND NOT EXISTS (
         SELECT 1 FROM marketing_flow_runs r
         WHERE r.flow_id = $4::uuid AND r.trigger_ref = c.id::text
       )`,
    [flow.store_id, cutoff, since, flow.id]
  );
  let n = 0;
  for (const row of rows) {
    const id = await enrollFlow(flow.store_id, flow, row.customer_id, row.cart_id, now);
    if (id) n++;
  }
  return n;
}
