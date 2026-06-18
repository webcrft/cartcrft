/**
 * product-qa/routes.ts — Product Q&A endpoints (Wave 21.1).
 *
 * Storefront (public) — mounted under the product:
 *   GET  /commerce/stores/:storeId/products/:productId/questions
 *        published+public questions for a product (storeAuthRead → cc_pub_ ok).
 *   POST /commerce/stores/:storeId/products/:productId/questions
 *        ask a question. A storefront CUSTOMER bearer (if present) attaches
 *        customer_id; otherwise an anonymous visitor must supply asker_name.
 *
 * Admin (merchant) — store-scoped moderation:
 *   GET    /commerce/stores/:storeId/questions?status=pending   (moderation queue)
 *   POST   /commerce/stores/:storeId/questions/:id/answer       (answer + publish)
 *   POST   /commerce/stores/:storeId/questions/:id/moderate     (publish/reject)
 *   DELETE /commerce/stores/:storeId/questions/:id              (delete)
 *
 * Asking is intentionally lenient on auth (mirrors back-in-stock/recovery): an
 * anonymous visitor can ask with just a display name. Moderation routes require
 * the standard admin store auth.
 */

import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getPool } from "../../db/pool.js";
import { config } from "../../config/config.js";
import { storeAuthRead, storeAuthAdmin } from "../../lib/auth/middleware.js";
import { bearerAuth, type CustomerClaims } from "../customer-auth/service.js";
import {
  askQuestion,
  answerQuestion,
  moderateQuestion,
  listQuestions,
  deleteQuestion,
} from "./service.js";

// ── Customer bearer resolution (mirrors back-in-stock/routes.ts) ────────────

async function resolveCustomer(
  authorization: string,
  storeId: string
): Promise<CustomerClaims | null> {
  const pool = getPool();
  const secretsKey = config.AUTH_SECRETS_KEY ?? "";
  const claims = await bearerAuth(pool, authorization, storeId, secretsKey);
  if (!claims || claims.store !== storeId) return null;
  return claims;
}

// storeAuthRead is overloaded (preHandler | factory). Narrow it to the plain
// async preHandler form for direct invocation inside askAuth.
const readGuard = storeAuthRead as unknown as (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<void>;

/**
 * Ask-route guard: accept a storefront CUSTOMER bearer (attaches
 * request.customer) OR fall back to the storefront-read guard (public cc_pub_
 * key / admin JWT). A customer token is tried first because storeAuthRead does
 * not understand customer JWTs.
 */
const askAuth: preHandlerHookHandler = async (request, reply) => {
  const params = request.params as Record<string, string>;
  const storeId = params["storeId"] ?? "";
  const authorization = request.headers["authorization"] ?? "";

  const claims = await resolveCustomer(authorization, storeId);
  if (claims) {
    request.customer = claims;
    return;
  }
  await readGuard(request, reply);
};

// ── Schemas ─────────────────────────────────────────────────────────────────

const UUID = z.string().uuid();
const ProductParams = z.object({ storeId: UUID, productId: UUID });
const QuestionParams = z.object({ storeId: UUID, id: UUID });
const StoreParams = z.object({ storeId: UUID });

const QuestionStatusEnum = z.enum(["pending", "published", "rejected"]);

const AskBody = z.object({
  question: z.string().min(1).max(2000),
  asker_name: z.string().min(1).max(120).optional(),
});

const AnswerBody = z.object({
  answer: z.string().min(1).max(4000),
  answered_by: z.string().min(1).max(120),
});

const ModerateBody = z.object({
  status: QuestionStatusEnum,
});

const AdminListQuery = z.object({
  status: QuestionStatusEnum.optional(),
  product_id: UUID.optional(),
});

// ── Plugin ───────────────────────────────────────────────────────────────────

export const productQaPlugin: FastifyPluginAsyncZod = async (app) => {
  // ── Storefront (public) ────────────────────────────────────────────────────

  // GET — published+public questions for a product.
  app.get(
    "/commerce/stores/:storeId/products/:productId/questions",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params;
      const questions = await listQuestions(storeId, {
        productId,
        publicOnly: true,
      });
      return reply.send({ questions });
    }
  );

  // POST — ask a question. Customer bearer attaches customer_id; otherwise an
  // anonymous visitor must supply asker_name.
  app.post(
    "/commerce/stores/:storeId/products/:productId/questions",
    {
      preHandler: [askAuth],
      schema: { params: ProductParams, body: AskBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params;
      const body = request.body;
      const customerId = request.customer?.sub;

      if (!customerId && !body.asker_name) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "asker_name is required when not authenticated as a customer",
          },
        });
      }

      try {
        const question = await askQuestion(storeId, productId, {
          question: body.question,
          ...(customerId !== undefined ? { customerId } : {}),
          ...(body.asker_name !== undefined ? { askerName: body.asker_name } : {}),
        });
        return reply.status(201).send(question);
      } catch (err) {
        if ((err as { code?: string }).code === "NOT_FOUND") {
          return reply.status(404).send({
            error: { code: "NOT_FOUND", message: "product not found" },
          });
        }
        throw err;
      }
    }
  );

  // ── Admin (merchant) ───────────────────────────────────────────────────────

  // GET — moderation queue (filter by status / product).
  app.get(
    "/commerce/stores/:storeId/questions",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: StoreParams, querystring: AdminListQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const q = request.query;
      const questions = await listQuestions(storeId, {
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.product_id !== undefined ? { productId: q.product_id } : {}),
      });
      return reply.send({ questions });
    }
  );

  // POST — answer a question (publishes unless rejected).
  app.post(
    "/commerce/stores/:storeId/questions/:id/answer",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: QuestionParams, body: AnswerBody },
    },
    async (request, reply) => {
      const { storeId, id } = request.params;
      const { answer, answered_by } = request.body;
      const updated = await answerQuestion(storeId, id, {
        answer,
        answeredBy: answered_by,
      });
      if (!updated) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "question not found" },
        });
      }
      return reply.send(updated);
    }
  );

  // POST — moderate (publish/reject).
  app.post(
    "/commerce/stores/:storeId/questions/:id/moderate",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: QuestionParams, body: ModerateBody },
    },
    async (request, reply) => {
      const { storeId, id } = request.params;
      const { status } = request.body;
      const updated = await moderateQuestion(storeId, id, status);
      if (!updated) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "question not found" },
        });
      }
      return reply.send(updated);
    }
  );

  // DELETE — remove a question.
  app.delete(
    "/commerce/stores/:storeId/questions/:id",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: QuestionParams },
    },
    async (request, reply) => {
      const { storeId, id } = request.params;
      const ok = await deleteQuestion(storeId, id);
      if (!ok) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "question not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );
};
