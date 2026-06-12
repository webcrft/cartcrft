/**
 * agent/search/embedder.ts — Embedder interface + adapters.
 *
 * Embedder contract:
 *   embed(texts)    → batch-produce float32 vectors, one per text
 *   model           → string identifier, e.g. "text-embedding-3-small"
 *   dimensions      → vector length, e.g. 1536
 *
 * Adapters:
 *   OpenAIEmbedder  — OpenAI-compatible /v1/embeddings API; uses the per-store
 *                     BYO key read from store metadata.llm_provider.api_key
 *                     (AES-256-GCM encrypted when AUTH_SECRETS_KEY is set).
 *   FakeEmbedder    — deterministic hash-based vectors; zero external calls;
 *                     designed for tests and dev.
 *
 * Storage choice for BYO LLM key:
 *   Stored in stores.metadata->>'llm_provider' as a jsonb object:
 *     { "api_key": "<encrypted-or-plaintext>",
 *       "model":   "text-embedding-3-small",
 *       "base_url": "https://api.openai.com/v1" }  ← base_url optional (OpenAI-compat)
 *   This reuses the existing stores.metadata jsonb column (no schema change),
 *   follows the same pattern as payment_providers.config, and the key is
 *   encrypted via lib/secrets.ts (AES-256-GCM) when AUTH_SECRETS_KEY is set.
 *   The field name mirrors the roadmap language ("BYO LLM key").
 */

import { createHash } from "node:crypto";
import { decodeSecretValue } from "../../lib/secrets.js";
import { config } from "../../config/config.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ── Store LLM provider config ──────────────────────────────────────────────────

export interface StoreLlmProvider {
  /** AES-256-GCM ciphertext (base64) or plaintext (dev mode) */
  api_key: string;
  /** OpenAI-compatible model identifier. Default: text-embedding-3-small */
  model?: string;
  /** Override base URL for OpenAI-compatible providers. Default: OpenAI */
  base_url?: string;
}

/**
 * Extract and decrypt the LLM provider config from stores.metadata.
 * Returns null if not configured.
 */
export function extractLlmProvider(
  metadata: Record<string, unknown>
): StoreLlmProvider | null {
  const raw = metadata["llm_provider"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p["api_key"] !== "string" || !p["api_key"]) return null;
  const secretsKey = config.AUTH_SECRETS_KEY ?? "";
  const apiKey = decodeSecretValue(p["api_key"] as string, secretsKey);
  const result: StoreLlmProvider = { api_key: apiKey };
  if (typeof p["model"] === "string") result.model = p["model"];
  if (typeof p["base_url"] === "string") result.base_url = p["base_url"];
  return result;
}

// ── OpenAIEmbedder ─────────────────────────────────────────────────────────────

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "text-embedding-3-small";
const OPENAI_DEFAULT_DIMENSIONS = 1536;
const MAX_BATCH = 96; // OpenAI limit per request is 2048 inputs; 96 is safe for large texts

export class OpenAIEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    dimensions?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? OPENAI_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/$/, "");
    this.dimensions = opts.dimensions ?? OPENAI_DEFAULT_DIMENSIONS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    // Batch to avoid hitting request-level limits.
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const batchVecs = await this._embedBatch(batch);
      results.push(...batchVecs);
    }

    return results;
  }

  private async _embedBatch(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({
      model: this.model,
      input: texts,
      encoding_format: "float",
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!resp.ok) {
      let detail = "";
      try {
        const txt = await resp.text();
        detail = txt.slice(0, 200);
      } catch {
        // ignore
      }
      throw new Error(
        `OpenAIEmbedder: HTTP ${resp.status} from ${url}: ${detail}`
      );
    }

    interface EmbeddingResponse {
      data: Array<{ index: number; embedding: number[] }>;
    }
    const json = (await resp.json()) as EmbeddingResponse;

    if (!json.data || !Array.isArray(json.data)) {
      throw new Error("OpenAIEmbedder: unexpected response shape");
    }

    // Sort by index (OpenAI guarantees order but be defensive).
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  /** Build an OpenAIEmbedder from a StoreLlmProvider config. */
  static fromProvider(p: StoreLlmProvider): OpenAIEmbedder {
    const opts: { apiKey: string; model?: string; baseUrl?: string } = {
      apiKey: p.api_key,
    };
    if (p.model) opts.model = p.model;
    if (p.base_url) opts.baseUrl = p.base_url;
    return new OpenAIEmbedder(opts);
  }
}

// ── FakeEmbedder ───────────────────────────────────────────────────────────────
//
// Deterministic hash-based vectors.
// Each dimension is derived from SHA-256 of (text + dimension index), mapped to
// [-1, 1].  Vectors are L2-normalised so cosine similarity works correctly.
// The same text always produces the same vector (test stability).

export class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder-v1";
  readonly dimensions: number;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this._vec(t)));
  }

  private _vec(text: string): number[] {
    const dims = this.dimensions;
    const vec = new Array<number>(dims);

    // Two SHA-256 passes to cover 1536 dims (SHA-256 = 32 bytes = 8 floats each)
    let offset = 0;
    let seed = 0;
    while (offset < dims) {
      const hash = createHash("sha256")
        .update(`${seed}:${text}`)
        .digest();
      for (let i = 0; i < 32 && offset < dims; i++) {
        // Map byte 0-255 → -1..1
        vec[offset++] = (hash[i]! / 127.5) - 1.0;
      }
      seed++;
    }

    // L2 normalise.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dims; i++) vec[i] = vec[i]! / norm;
    }

    return vec;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build an Embedder from store metadata.
 * Returns null if no LLM provider is configured (full-text fallback path).
 *
 * Special model names (for tests and dev):
 *   "fake-embedder-v1" → FakeEmbedder (deterministic hash-based, no network)
 */
export function buildEmbedder(
  storeMetadata: Record<string, unknown>
): Embedder | null {
  const provider = extractLlmProvider(storeMetadata);
  if (!provider) return null;
  // Development / test escape hatch: use FakeEmbedder when model is "fake-embedder-v1".
  if (provider.model === "fake-embedder-v1") {
    return new FakeEmbedder();
  }
  return OpenAIEmbedder.fromProvider(provider);
}
