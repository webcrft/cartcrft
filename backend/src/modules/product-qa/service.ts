/**
 * product-qa/service.ts — Product Q&A: customer questions + merchant answers.
 *
 * A shopper asks a question on a product (pending). The merchant answers it
 * (which publishes it) or moderates it (publish/reject). Published+public
 * questions appear on the public product page.
 *
 * Public API:
 *   askQuestion(storeId, productId, { customerId?, askerName?, question })
 *   answerQuestion(storeId, questionId, { answer, answeredBy })
 *   moderateQuestion(storeId, questionId, status)
 *   listQuestions(storeId, { productId?, status?, publicOnly? })
 *   deleteQuestion(storeId, questionId)
 *
 * All SQL is parameterized and scoped by store_id (RLS enforces the same).
 * Mirrors the product_reviews moderation model (catalog/service.ts): nothing
 * is publicly visible until the merchant acts.
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import type {
  ProductQuestion,
  AskQuestionInput,
  AnswerQuestionInput,
  ListQuestionsOptions,
  QuestionStatus,
} from "./types.js";

/** Columns selected for every ProductQuestion read (uuid → text). */
const QUESTION_COLUMNS = `
  id::text, store_id::text, product_id::text, customer_id::text,
  asker_name, question, status, answer, answered_by, answered_at,
  is_public, created_at, updated_at
`;

// ── askQuestion ─────────────────────────────────────────────────────────────

/**
 * Insert a new PENDING question for a product. The asker is EITHER a logged-in
 * customer (customerId) OR an anonymous storefront visitor who supplied a
 * display name (askerName). Validates the product belongs to the store first.
 */
export async function askQuestion(
  storeId: string,
  productId: string,
  input: AskQuestionInput
): Promise<ProductQuestion> {
  const pool = getPool();
  const { rows: pRows } = await pool.query(
    `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!pRows[0]) {
    throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });
  }

  const { rows } = await pool.query<ProductQuestion>(
    `INSERT INTO product_questions
       (store_id, product_id, customer_id, asker_name, question, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'pending')
     RETURNING ${QUESTION_COLUMNS}`,
    [
      storeId,
      productId,
      input.customerId ?? null,
      input.askerName ?? null,
      input.question,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("askQuestion: no row returned");
  return row;
}

// ── answerQuestion ──────────────────────────────────────────────────────────

/**
 * Set a merchant answer on a question and stamp answered_at/answered_by.
 * Answering publishes the question (status='published') UNLESS it was already
 * rejected — a rejected question stays hidden even if an answer is attached.
 * Returns the updated row, or null when the question does not exist in store.
 */
export async function answerQuestion(
  storeId: string,
  questionId: string,
  input: AnswerQuestionInput
): Promise<ProductQuestion | null> {
  return withTx(async (client) => {
    const { rows } = await client.query<ProductQuestion>(
      `UPDATE product_questions SET
         answer      = $3,
         answered_by = $4,
         answered_at = now(),
         status      = CASE WHEN status = 'rejected' THEN status ELSE 'published' END,
         updated_at  = now()
       WHERE id = $1::uuid AND store_id = $2::uuid
       RETURNING ${QUESTION_COLUMNS}`,
      [questionId, storeId, input.answer, input.answeredBy]
    );
    return rows[0] ?? null;
  });
}

// ── moderateQuestion ────────────────────────────────────────────────────────

/**
 * Set a question's moderation status (publish/reject). Returns the updated row,
 * or null when the question does not exist within the store.
 */
export async function moderateQuestion(
  storeId: string,
  questionId: string,
  status: QuestionStatus
): Promise<ProductQuestion | null> {
  return withTx(async (client) => {
    const { rows } = await client.query<ProductQuestion>(
      `UPDATE product_questions SET
         status     = $3,
         updated_at = now()
       WHERE id = $1::uuid AND store_id = $2::uuid
       RETURNING ${QUESTION_COLUMNS}`,
      [questionId, storeId, status]
    );
    return rows[0] ?? null;
  });
}

// ── listQuestions ───────────────────────────────────────────────────────────

/**
 * List questions for a store. Admin callers may filter by productId and/or
 * status. When publicOnly is set (storefront), only status='published' AND
 * is_public rows are returned regardless of any status filter — mirrors the
 * product_reviews public listing.
 */
export async function listQuestions(
  storeId: string,
  opts: ListQuestionsOptions = {}
): Promise<ProductQuestion[]> {
  const db = getReadDb();
  const args: unknown[] = [storeId];
  let where = `store_id = $1::uuid`;

  if (opts.productId) {
    args.push(opts.productId);
    where += ` AND product_id = $${args.length}::uuid`;
  }

  if (opts.publicOnly) {
    where += ` AND status = 'published' AND is_public = true`;
  } else if (opts.status) {
    args.push(opts.status);
    where += ` AND status = $${args.length}`;
  }

  const { rows } = await db.query<ProductQuestion>(
    `SELECT ${QUESTION_COLUMNS}
       FROM product_questions
      WHERE ${where}
      ORDER BY created_at DESC`,
    args
  );
  return rows;
}

// ── deleteQuestion ──────────────────────────────────────────────────────────

/**
 * Delete a question. Returns true when a row was removed within the store.
 */
export async function deleteQuestion(
  storeId: string,
  questionId: string
): Promise<boolean> {
  return withTx(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM product_questions
        WHERE id = $1::uuid AND store_id = $2::uuid`,
      [questionId, storeId]
    );
    return (rowCount ?? 0) > 0;
  });
}
