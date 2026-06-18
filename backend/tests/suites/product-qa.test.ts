/**
 * product-qa — Vitest integration suite (Wave 21.1).
 *
 * Covers the product Q&A flow:
 *   GET    /commerce/stores/:storeId/products/:productId/questions  (public)
 *   POST   /commerce/stores/:storeId/products/:productId/questions  (ask)
 *   GET    /commerce/stores/:storeId/questions?status=pending       (admin queue)
 *   POST   /commerce/stores/:storeId/questions/:id/answer           (answer)
 *   POST   /commerce/stores/:storeId/questions/:id/moderate         (publish/reject)
 *   DELETE /commerce/stores/:storeId/questions/:id                  (delete)
 *
 * Verifies:
 *   - ask → pending, NOT in the public list;
 *   - answer → published + appears in the public product list with the answer;
 *   - moderate reject hides a previously published question;
 *   - public list excludes pending/rejected;
 *   - admin queue shows pending;
 *   - delete removes the question.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, del, mintJwt, insertProduct } from "../shared/helpers.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";

let ctx: TestCtx;

beforeAll(async () => {
  setMailerForTesting(new ConsoleMailer());
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function bearer(token: string) {
  return { type: "bearer" as const, token };
}

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const adminToken = await mintJwt({ userId, orgId });
  const auth = bearer(adminToken);

  const res = await post(ctx, "/commerce/stores", { name: "QA Test Store", currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  const storeId = (res.json as Record<string, unknown>)["id"] as string;
  return { storeId, auth };
}

type QRow = Record<string, unknown>;

function publicQuestions(json: Record<string, unknown>): QRow[] {
  return json["questions"] as QRow[];
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Product Q&A — ask, answer/publish, moderate, public visibility, delete", () => {
  it("ask → pending and NOT in the public list", async () => {
    const { storeId, auth } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId });

    const askRes = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "Is this waterproof?", asker_name: "Sam" },
      auth,
    );
    expect(askRes.status).toBe(201);
    expect(askRes.json["status"]).toBe("pending");

    // Public list shows nothing while pending.
    const pubRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      auth,
    );
    expect(pubRes.status).toBe(200);
    expect(publicQuestions(pubRes.json).length).toBe(0);
  });

  it("answer → published and appears in the public product list WITH the answer", async () => {
    const { storeId, auth } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId });

    const askRes = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "How long is the battery life?", asker_name: "Pat" },
      auth,
    );
    const qId = askRes.json["id"] as string;

    const ansRes = await post(
      ctx,
      `/commerce/stores/${storeId}/questions/${qId}/answer`,
      { answer: "About 10 hours.", answered_by: "Merchant" },
      auth,
    );
    expect(ansRes.status).toBe(200);
    expect(ansRes.json["status"]).toBe("published");
    expect(ansRes.json["answered_at"]).not.toBeNull();

    const pubRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      auth,
    );
    const qs = publicQuestions(pubRes.json);
    expect(qs.length).toBe(1);
    expect(qs[0]!["id"]).toBe(qId);
    expect(qs[0]!["answer"]).toBe("About 10 hours.");
    expect(qs[0]!["status"]).toBe("published");
  });

  it("moderate reject hides a previously published question", async () => {
    const { storeId, auth } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId });

    const askRes = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "Does it ship internationally?", asker_name: "Lee" },
      auth,
    );
    const qId = askRes.json["id"] as string;

    await post(
      ctx,
      `/commerce/stores/${storeId}/questions/${qId}/answer`,
      { answer: "Yes, worldwide.", answered_by: "Merchant" },
      auth,
    );

    // Visible after answer.
    let pubRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      auth,
    );
    expect(publicQuestions(pubRes.json).length).toBe(1);

    // Reject → hidden.
    const modRes = await post(
      ctx,
      `/commerce/stores/${storeId}/questions/${qId}/moderate`,
      { status: "rejected" },
      auth,
    );
    expect(modRes.status).toBe(200);
    expect(modRes.json["status"]).toBe("rejected");

    pubRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      auth,
    );
    expect(publicQuestions(pubRes.json).length).toBe(0);
  });

  it("public list excludes pending and rejected; admin queue shows pending", async () => {
    const { storeId, auth } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId });

    // One pending.
    await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "Q-pending", asker_name: "A" },
      auth,
    );
    // One that will be published.
    const pubAsk = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "Q-published", asker_name: "B" },
      auth,
    );
    await post(
      ctx,
      `/commerce/stores/${storeId}/questions/${pubAsk.json["id"]}/answer`,
      { answer: "Answer B", answered_by: "Merchant" },
      auth,
    );
    // One rejected.
    const rejAsk = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "Q-rejected", asker_name: "C" },
      auth,
    );
    await post(
      ctx,
      `/commerce/stores/${storeId}/questions/${rejAsk.json["id"]}/moderate`,
      { status: "rejected" },
      auth,
    );

    // Public: only the published one.
    const pubRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      auth,
    );
    const pubQs = publicQuestions(pubRes.json);
    expect(pubQs.length).toBe(1);
    expect(pubQs[0]!["question"]).toBe("Q-published");

    // Admin moderation queue (status=pending): only the pending one.
    const queueRes = await get(
      ctx,
      `/commerce/stores/${storeId}/questions?status=pending`,
      auth,
    );
    expect(queueRes.status).toBe(200);
    const queue = publicQuestions(queueRes.json);
    expect(queue.length).toBe(1);
    expect(queue[0]!["question"]).toBe("Q-pending");
  });

  it("ask requires asker_name when anonymous (no customer bearer)", async () => {
    const { storeId, auth } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "No name given" },
      auth,
    );
    expect(res.status).toBe(400);
  });

  it("delete removes a question", async () => {
    const { storeId, auth } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId });

    const askRes = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${product.id}/questions`,
      { question: "Delete me?", asker_name: "Z" },
      auth,
    );
    const qId = askRes.json["id"] as string;

    const delRes = await del(ctx, `/commerce/stores/${storeId}/questions/${qId}`, auth);
    expect(delRes.status).toBe(200);
    expect(delRes.json["ok"]).toBe(true);

    const { rows } = await ctx.pool.query(
      `SELECT id FROM product_questions WHERE id = $1::uuid`,
      [qId],
    );
    expect(rows.length).toBe(0);
  });
});
