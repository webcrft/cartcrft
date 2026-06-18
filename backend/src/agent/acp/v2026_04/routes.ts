/**
 * ACP 2026-04 — Fastify plugin for versioned ACP endpoints.
 *
 * Routes are relative (no /acp prefix) — the parent acpPlugin registers
 * this under /acp (unversioned) and /acp/v2026-04 (explicit version).
 *
 * Effective endpoints (with parent prefix):
 *   GET  /acp/:storeId/feed
 *   POST /acp/:storeId/checkout_sessions
 *   GET  /acp/:storeId/checkout_sessions/:sessionId
 *   POST /acp/:storeId/checkout_sessions/:sessionId
 *   POST /acp/:storeId/checkout_sessions/:sessionId/complete
 *
 * Auth: cc_pub_ or cc_prv_ with commerce:read (storeAuthRead).
 * ACP-Version: "2026-04" header returned on all responses.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { storeAuthRead } from "../../../lib/auth/middleware.js";
import { getAcpFeed } from "./feed.js";
import {
  createSession,
  getSession,
  updateSession,
  completeSession,
  AcpError,
  type CreateSessionInput,
  type UpdateSessionInput,
  type CompleteSessionInput,
} from "./sessions.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

const SessionParams = z.object({
  storeId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

const FeedQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

const AddressSchema = z
  .object({
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    address1: z.string().optional(),
    address2: z.string().optional(),
    city: z.string().optional(),
    province_code: z.string().optional(),
    zip: z.string().optional(),
    country_code: z.string().optional(),
  })
  .passthrough();

const LineItemSchema = z.object({
  variant_id: z.string().uuid("variant_id must be a UUID"),
  quantity: z.number().int().min(1).max(1000),
});

const BuyerSchema = z.object({
  email: z.string().email().optional(),
  shipping_address: AddressSchema.optional(),
  billing_address: AddressSchema.optional(),
});

const CreateSessionBody = z.object({
  line_items: z.array(LineItemSchema).min(1, "line_items must not be empty"),
  buyer: BuyerSchema.optional(),
  selected_fulfillment_id: z.string().uuid().optional(),
});

const UpdateSessionBody = z.object({
  buyer: BuyerSchema.optional(),
  selected_fulfillment_id: z.string().uuid().optional(),
});

const CompleteSessionBody = z.object({
  payment_data: z
    .object({
      token: z.string().optional(),
      mode: z.enum(["test", "live"]).optional(),
    })
    .optional(),
});

// ── Helper — map AcpError to HTTP response ────────────────────────────────────

function sendAcpError(reply: FastifyReply, err: unknown): ReturnType<FastifyReply["send"]> {
  if (err instanceof AcpError) {
    return reply.status(err.httpStatus).send({
      error: { code: err.code, message: err.message },
    });
  }
  throw err;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const acpV2026_04Plugin: FastifyPluginAsync = async (app) => {
  // ACP-Version header on all responses from this plugin scope
  app.addHook("onSend", async (_req, reply) => {
    void reply.header("ACP-Version", "2026-04");
  });

  // ── GET /:storeId/feed ─────────────────────────────────────────────────────
  app.get(
    "/:storeId/feed",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: StoreIdParams,
        querystring: FeedQuerystring,
      },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreIdParams>;
      const { limit, cursor } = request.query as z.infer<typeof FeedQuerystring>;

      try {
        const feed = await getAcpFeed(storeId, limit, cursor);
        return reply.send(feed);
      } catch (err) {
        return sendAcpError(reply, err);
      }
    }
  );

  // ── POST /:storeId/checkout_sessions — create ──────────────────────────────
  app.post(
    "/:storeId/checkout_sessions",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: StoreIdParams,
        body: CreateSessionBody,
      },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreIdParams>;
      const body = request.body as CreateSessionInput;
      const idempotencyKeyValue = request.headers["idempotency-key"] as string | undefined;

      try {
        const session = await createSession(storeId, body, idempotencyKeyValue);
        return reply.status(201).send({ session });
      } catch (err) {
        return sendAcpError(reply, err);
      }
    }
  );

  // ── GET /:storeId/checkout_sessions/:sessionId — get ──────────────────────
  app.get(
    "/:storeId/checkout_sessions/:sessionId",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: SessionParams,
      },
    },
    async (request, reply) => {
      const { storeId, sessionId } = request.params as z.infer<typeof SessionParams>;

      try {
        const session = await getSession(storeId, sessionId);
        return reply.send({ session });
      } catch (err) {
        return sendAcpError(reply, err);
      }
    }
  );

  // ── POST /:storeId/checkout_sessions/:sessionId — update ──────────────────
  app.post(
    "/:storeId/checkout_sessions/:sessionId",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: SessionParams,
        body: UpdateSessionBody,
      },
    },
    async (request, reply) => {
      const { storeId, sessionId } = request.params as z.infer<typeof SessionParams>;
      const body = request.body as UpdateSessionInput;

      try {
        const session = await updateSession(storeId, sessionId, body);
        return reply.send({ session });
      } catch (err) {
        return sendAcpError(reply, err);
      }
    }
  );

  // ── POST /:storeId/checkout_sessions/:sessionId/complete ──────────────────
  app.post(
    "/:storeId/checkout_sessions/:sessionId/complete",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: SessionParams,
        body: CompleteSessionBody,
      },
    },
    async (request, reply) => {
      const { storeId, sessionId } = request.params as z.infer<typeof SessionParams>;
      const body = request.body as CompleteSessionInput;
      const idempotencyKeyValue = request.headers["idempotency-key"] as string | undefined;

      try {
        // Thread agent attribution (set by the global agentAttributionHook) so
        // completeSession → completeCheckout enforces spend/mandate limits when
        // the request carries agent signature headers. Plain merchant-key
        // requests have agentCtx === undefined → unchanged behaviour.
        const result = await completeSession(
          storeId,
          sessionId,
          body,
          idempotencyKeyValue,
          request.agentCtx
        );
        return reply.send({
          session: result.session,
          order_id: result.orderId,
          order_number: result.orderNumber,
        });
      } catch (err) {
        return sendAcpError(reply, err);
      }
    }
  );
};
