/**
 * Config — zod-validated environment config.
 *
 * Loads .env from the repo root when APP_ENV is "development" (or unset).
 * Var names mirror webcrft-mono .env.dev so the same .env file works.
 * Boot must not require provider keys — optional vars are optional.
 */
import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Locate repo root (.env lives there) ────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/config/ → src/ → backend/ → repo root
const repoRoot = path.resolve(__dirname, "../../..");

// ── Load .env in dev (non-production) ──────────────────────────────────────
const appEnvRaw = process.env["APP_ENV"] ?? "development";
if (appEnvRaw !== "production") {
  dotenvConfig({ path: path.join(repoRoot, ".env") });
}

// ── Schema ─────────────────────────────────────────────────────────────────
const configSchema = z.object({
  // Core
  APP_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // JWT
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRY_HOURS: z.coerce.number().positive().default(24),

  // Frontend
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  BASE_DOMAIN: z.string().default("localhost"),

  // Provider secrets encryption (AES-256-GCM)
  // Optional — keys stored unencrypted in dev without it; required in prod.
  AUTH_SECRETS_KEY: z.string().optional(),

  // Payments (BYO keys — all optional at boot)
  PAYSTACK_SECRET_KEY: z.string().optional(),

  // AWS SES
  AWS_SES_REGION: z.string().optional(),
  AWS_SES_ACCESS_KEY_ID: z.string().optional(),
  AWS_SES_SECRET_ACCESS_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Exchange rates
  EXCHANGE_RATE_API_KEY: z.string().optional(),

  // Billing sim
  BILLING_SIM_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  BILLING_SIM_DAY_SECONDS: z.coerce.number().int().positive().default(86400),

  // Rate limiting
  IP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

export type RawConfig = z.infer<typeof configSchema>;

function load(): RawConfig {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    // Format errors clearly but never print values.
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const cfg = result.data;

  // Production guards (mirrors webcrft main.go)
  if (cfg.APP_ENV === "production" && !cfg.AUTH_SECRETS_KEY) {
    throw new Error(
      "AUTH_SECRETS_KEY is required in production (APP_ENV=production)"
    );
  }
  if (cfg.BILLING_SIM_ENABLED && cfg.APP_ENV === "production") {
    throw new Error(
      "BILLING_SIM_ENABLED=true but APP_ENV=production. " +
        "Refusing to start to prevent real charges on a compressed clock."
    );
  }

  return cfg;
}

export const config = load();

/** Mask a string for safe logging (shows first 4 chars + …). */
export function mask(s: string | undefined): string {
  if (!s) return "(not set)";
  if (s.length <= 4) return "****";
  return s.slice(0, 4) + "…";
}
