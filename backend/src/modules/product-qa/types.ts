/**
 * product-qa/types.ts — shared types for the product Q&A module (Wave 21.1).
 *
 * All DB-facing IDs are string (uuid text). Timestamps are ISO strings as
 * returned by pg. A question's lifecycle is pending → published | rejected;
 * the public listing only ever exposes published+public rows.
 */

export type QuestionStatus = "pending" | "published" | "rejected";

export interface ProductQuestion {
  id: string;
  store_id: string;
  product_id: string;
  customer_id: string | null;
  asker_name: string | null;
  question: string;
  status: QuestionStatus;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface AskQuestionInput {
  customerId?: string | undefined;
  askerName?: string | undefined;
  question: string;
}

export interface AnswerQuestionInput {
  answer: string;
  answeredBy: string;
}

export interface ListQuestionsOptions {
  productId?: string | undefined;
  status?: QuestionStatus | undefined;
  /** When true, return only published+public rows (storefront visibility). */
  publicOnly?: boolean | undefined;
}
