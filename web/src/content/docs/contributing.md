---
title: "Contributing"
description: "Developer guide for the Cartcrft monorepo."
# TODO(docs-agent): refine title, description, sidebar label, and ordering
---

# Contributing

Developer guide for the Cartcrft monorepo.

---

## Monorepo layout

```
cartcrft/
├── LICENSE                     # MIT (everything except cloud/)
├── README.md
├── roadmap.md                  # destination map
├── tasks.md                    # work queue (append-only)
├── assets/                     # logo SVG
├── package.json                # workspace root (scripts only, private)
├── pnpm-workspace.yaml         # packages: backend, admin, sdk, cloud/billing
├── tsconfig.base.json          # shared TS config (strict, ES2023, NodeNext)
├── .nvmrc                      # node 22
├── backend/                    # TypeScript headless commerce core (MIT)
│   ├── src/
│   │   ├── main.ts             # entrypoint: serve | worker | migrate
│   │   ├── config/config.ts    # zod-validated env config
│   │   ├── db/                 # pg pool, withTx helper, migration runner
│   │   ├── http/app.ts         # Fastify factory, error envelope, /healthz
│   │   ├── modules/            # commerce domains (one dir per domain)
│   │   ├── agent/              # MCP server, ACP adapter, semantic search
│   │   ├── providers/          # payment + shipping provider clients
│   │   ├── webhooks/           # inbound webhook router + signature verifiers
│   │   ├── lib/                # auth middleware, secrets, money, tax, mailer
│   │   └── seed/               # demo store seed script
│   ├── migrations/             # plain SQL, numbered (0001_*.sql …)
│   ├── tests/
│   │   ├── shared/             # ctx.ts (schema isolation), helpers.ts
│   │   ├── suites/             # one *.test.ts per suite
│   │   ├── TESTS.md            # suite index
│   │   └── RESULTS.md          # run log
│   └── package.json
├── admin/                      # React 19 + Vite admin SPA (MIT)
├── mcp/                        # MCP usage docs + client config examples (MIT)
├── sdk/                        # @cartcrft/sdk (generated from OpenAPI) (MIT)
├── cloud/
│   ├── LICENSE                 # Cartcrft Cloud License v1.0
│   └── billing/                # cloud metering + billing (not MIT)
└── docs/                       # this directory
```

---

## pnpm commands

Run these from the repo root unless noted otherwise.

| Command | What it does |
|---------|-------------|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Start backend in watch mode (`tsx watch`) |
| `pnpm migrate` | Apply pending SQL migrations |
| `pnpm seed` | Create/update demo store (idempotent) |
| `pnpm build` | TypeScript compile across all packages |
| `pnpm typecheck` | Type-check without emitting (all packages) |
| `pnpm test` | Run all Vitest suites |
| `pnpm suite <name>` | Run one suite: `pnpm suite smoke` |

### Backend-specific

```bash
cd backend
pnpm dev          # same as root pnpm dev
pnpm mcp:stdio    # start MCP stdio server
pnpm suite smoke  # run smoke suite only
```

---

## Module pattern

Each commerce domain lives in `backend/src/modules/<domain>/` with three files:

- `routes.ts` — Fastify plugin; zod request/response schemas; mounts endpoints
- `service.ts` — all SQL + business logic; no HTTP types
- `types.ts` — TypeScript interfaces for the domain

Routes are mounted in `backend/src/http/app.ts`. Every new domain follows this
pattern.

---

## Migration numbering rules

Migrations live in `backend/migrations/NNNN_name.sql` where `NNNN` is a
zero-padded integer. Rules:

1. **Always use the next free number.** Check the directory before creating a
   file: `ls backend/migrations/` and use the highest number + 1.
2. **Never reuse or renumber.** Applied migrations are recorded in
   `schema_migrations` by filename — renaming breaks the idempotency check.
3. **One concern per file.** Prefer focused migrations over large omnibus files.
4. **Plain SQL only.** No migration framework dependencies. The runner applies
   each file in its own transaction (`BEGIN` / `COMMIT`).
5. **Guard extensions.** Wrap `CREATE EXTENSION` in a `DO $$ BEGIN ... EXCEPTION WHEN ... END $$` block so the migration does not fail when the extension is already installed or unavailable.

**The 0008/0009 collision lesson:** During Wave 2 development, `0008_customer_auth_ext.sql`
was created at the same time as what became `0009_payment_gateways.sql`. One
agent picked 0008 for its migration while another agent had already claimed 0008
for a different concern. The result was a filename conflict that required one
file to be renumbered to 0009. The fix is always to check the directory first.
When in doubt, choose a higher number with a gap — the runner applies files in
lexicographic order, so gaps are harmless.

Current migration count: **0001–0012** (12 files).

---

## TypeScript conventions

- **`strict: true`**, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax`
  — enforced in `tsconfig.base.json`.
- ESM only: `"type": "module"` in all `package.json` files. Import with `.js`
  extensions (resolved to `.ts` by tsx/tsc).
- No `any` except quarantined with a comment explaining why.
- Money amounts: strings in API payloads (`"89.00"`), `numeric(15,2)` in DB,
  integer cents only inside provider clients.
- All IDs returned as `::text` in SQL `SELECT` (UUIDs come out as strings).

---

## Error conventions

All errors use the envelope `{ error: { code, message, details? } }`. Throw via:

```typescript
const e = new Error("product not found");
(e as NodeJS.ErrnoException).code = "NOT_FOUND";
throw e;
```

The Fastify error handler in `http/app.ts` maps this to the wire format. See
[api-overview.md](./api-overview.md) for the full error code list.

---

## Commit style

```
<type>(<scope>): <summary>

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`.

Scope = the domain or package touched: `catalog`, `checkout`, `mcp`, `billing`,
`migrations`, `docs`, etc.

Examples:
```
feat(checkout): atomic complete with FOR UPDATE serialization
fix(catalog): correct OptionPublic type (no created_at)
chore(migrations): add 0013_search_indexes.sql
docs: quickstart, api overview, byo-keys
```

---

## tasks.md conventions

`tasks.md` is append-only:
- Add new work items under **Discovered** at the bottom.
- Mark completed tasks `[x]` with a date + commit hash note in their entry.
- Move completed items to the **Done** section with a brief note.
- Never delete or reorder existing entries.

---

## Definition of done

A task is done when:

1. `pnpm -r typecheck` passes.
2. `pnpm -r build` passes.
3. The relevant test suite(s) pass: `pnpm suite <name>`.
4. `pnpm suite smoke` still passes (regression check).
5. `tasks.md` updated: mark done, add note.

---

## Parallel agent safety

Multiple build agents may work in parallel on different domains. Shared rules:

- Check `git status` before wide edits.
- Stage only your own files (`git add <specific-files>`).
- If `git index.lock` is busy, wait 5 seconds and retry.
- Never touch files owned by another in-flight task (check tasks.md for
  in-progress items).
- Parallel agents: each owns a slice of `backend/src/modules/` and tests.
  The cloud agent owns `cloud/billing/` exclusively.
