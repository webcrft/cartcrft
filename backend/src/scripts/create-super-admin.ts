/**
 * create-super-admin.ts — One-off CLI to provision a platform super-admin.
 *
 * Migration 0025 deliberately seeds NO default super-admin (avoids a shipped
 * credential). Use this script to mint the first (or an additional) operator.
 *
 * Usage:
 *   # via env (recommended — keeps the password out of shell history):
 *   SUPERADMIN_EMAIL=ops@webcrft.systems SUPERADMIN_PASSWORD='…' \
 *     pnpm --filter backend exec tsx src/scripts/create-super-admin.ts
 *
 *   # via args:
 *   pnpm --filter backend exec tsx src/scripts/create-super-admin.ts \
 *     --email ops@webcrft.systems --password '…'
 *
 *   # with MFA (TOTP): pass a base32 secret to enable TOTP on first login.
 *   …  --totp-secret JBSWY3DPEHPK3PXP
 *   (The secret is AES-encrypted via lib/secrets using AUTH_SECRETS_KEY before
 *    storage. Provision the matching secret in an authenticator app.)
 *
 * Idempotency: re-running with an existing email UPDATES the password (and TOTP)
 * for that operator rather than creating a duplicate. Pass --no-update to refuse.
 *
 * Requires: DATABASE_URL (and AUTH_SECRETS_KEY if --totp-secret is used in prod).
 */

import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashSuperAdminPassword } from "../lib/superadmin-auth.js";
import { encodeSecretValue } from "../lib/secrets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/scripts/ → src/ → backend/ → repo root
const repoRoot = path.resolve(__dirname, "../../..");
dotenvConfig({ path: path.join(repoRoot, ".env"), override: false });

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key.startsWith("no-")) {
        out[key.slice(3)] = false;
      } else if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const email = (args["email"] as string) ?? process.env["SUPERADMIN_EMAIL"];
  const password = (args["password"] as string) ?? process.env["SUPERADMIN_PASSWORD"];
  const totpSecret = (args["totp-secret"] as string) ?? process.env["SUPERADMIN_TOTP_SECRET"];
  const allowUpdate = args["update"] !== false;

  if (!email || !password) {
    console.error(
      "Error: email and password are required.\n" +
        "  Provide --email/--password or SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD."
    );
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("Error: password must be at least 12 characters.");
    process.exit(1);
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("Error: DATABASE_URL is not set.");
    process.exit(1);
  }

  const passwordHash = hashSuperAdminPassword(password);
  const totpEnc = totpSecret
    ? encodeSecretValue(totpSecret, process.env["AUTH_SECRETS_KEY"] ?? "")
    : null;

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query<{ id: string }>(
      `SELECT id::text FROM super_admins WHERE lower(email) = lower($1)`,
      [email]
    );

    if (existing.rows[0]) {
      if (!allowUpdate) {
        console.error(`Error: super-admin ${email} already exists (pass --update to overwrite).`);
        process.exit(1);
      }
      await client.query(
        `UPDATE super_admins
            SET password_hash = $2,
                totp_secret_enc = COALESCE($3, totp_secret_enc),
                is_active = true, failed_attempts = 0, locked_until = NULL,
                updated_at = now()
          WHERE id = $1::uuid`,
        [existing.rows[0].id, passwordHash, totpEnc]
      );
      console.log(`Updated super-admin: ${email} (id=${existing.rows[0].id})${totpEnc ? " [TOTP set]" : ""}`);
    } else {
      const res = await client.query<{ id: string }>(
        `INSERT INTO super_admins (email, password_hash, totp_secret_enc)
         VALUES ($1, $2, $3)
         RETURNING id::text`,
        [email, passwordHash, totpEnc]
      );
      console.log(`Created super-admin: ${email} (id=${res.rows[0]!.id})${totpEnc ? " [TOTP enabled]" : ""}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("create-super-admin failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
