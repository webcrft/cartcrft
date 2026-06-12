# Testing Guide

Cartcrft uses Vitest with a suite-per-concern layout. Integration suites boot
the real Fastify app against a real Postgres database in an isolated schema —
no mocking of the database layer.

---

## Running suites

```bash
# Run a single suite
pnpm suite <name>

# Examples
pnpm suite smoke
pnpm suite checkout/checkout
pnpm suite catalog
pnpm suite mandates
pnpm suite search

# Run all suites
pnpm test
```

`pnpm suite` is a root-workspace alias for `pnpm --filter backend suite --`.
The backend script (`backend/scripts/suite.mjs`) resolves the suite name to
`backend/tests/suites/<name>.test.ts` and runs it with `vitest run`.

Suite files live at `backend/tests/suites/<name>.test.ts`. Some suites are
nested: `checkout/checkout`, `checkout/idempotency`, `checkout/concurrency`, etc.

---

## Test harness design

### Isolated schema per run

`backend/tests/shared/ctx.ts` boots the real Fastify app against the
`DATABASE_URL` from `.env`, creates a fresh Postgres schema
`test_<8-hex-runid>`, runs all migrations into that schema, and returns a test
context object. At the end of the suite `teardown()` drops the schema.

```typescript
import { createCtx } from '../shared/ctx.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await createCtx(); });
afterAll(async () => { await ctx.teardown(); });
```

**Isolation mechanism:**

1. A unique schema `test_<runid>` is created for each test run.
2. The pg pool connection string gets `options=-csearch_path=<schema>` so every
   connection uses the test schema automatically.
3. Migration SQL is rewritten: `public.table` → `"<schema>".table` so
   explicitly-qualified DDL also lands in the test schema.
4. `teardown()` issues `DROP SCHEMA ... CASCADE`.

Multiple suites can run in parallel against the same database — each has its
own schema.

### Why real HTTP, not mocked routes?

The test philosophy (ported from webcrft-mono) is that integration tests should
exercise the full request path: Fastify routing, zod validation, auth middleware,
SQL, and response serialisation. This catches bugs that unit tests of individual
functions would not — wrong auth tier, missing `::text` cast in a SELECT,
transaction isolation issues.

The server binds to an ephemeral OS-assigned port (`:0`) so tests never conflict
with a running dev server.

---

## Writing a new suite

Create `backend/tests/suites/<name>.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createCtx, type TestCtx } from '../shared/ctx.js';
import { mintJwt, makeStore } from '../shared/helpers.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
});

afterAll(async () => {
  await ctx.teardown();
});

describe('my feature', () => {
  it('creates a thing', async () => {
    // 1. Create fixtures using helpers
    const jwt = mintJwt({ userId: 'user-uuid', orgId: 'org-uuid' });
    const store = await makeStore(ctx, jwt);

    // 2. Make HTTP requests via ctx.request()
    const res = await ctx.request({
      method: 'POST',
      path: `/commerce/stores/${store.id}/things`,
      body: { name: 'My Thing' },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    // 3. Assert
    expect(res.status).toBe(201);
    expect(res.json.name).toBe('My Thing');
  });
});
```

### Helper utilities

`backend/tests/shared/helpers.ts` provides:

- `mintJwt({ userId, orgId })` — creates a valid HS256 JWT for management auth
- `makeStore(ctx, jwt, overrides?)` — creates a store and returns its record
- `makeProduct(ctx, jwt, storeId, overrides?)` — creates a product
- `makeVariant(ctx, jwt, storeId, productId, overrides?)` — creates a variant
- `makeCustomer(ctx, jwt, storeId, overrides?)` — creates a customer
- `makeApiKey(ctx, jwt, storeId, type?)` — issues a `cc_pub_` or `cc_prv_` key
- `request(ctx, opts)` — typed HTTP wrapper (Content-Type: application/json auto)

---

## Suite index

The full suite index is in `backend/tests/TESTS.md`. Current passing suites:

| Suite | Tests | Domain |
|-------|-------|--------|
| `smoke` | 6 | /healthz, migration idempotency, error envelope |
| `stores` | 16 | Store CRUD, org scoping |
| `apikeys` | 21 | cc_ key issue/verify, scope enforcement |
| `catalog` | 77 | Products, variants, options, collections, price lists |
| `catalog-validation` | 28 | 400 rejection contracts |
| `checkout/checkout` | 21 | Cart → checkout → atomic complete |
| `checkout/idempotency` | 5 | Second complete is idempotent |
| `checkout/concurrency` | 3 | FOR UPDATE serialization |
| `checkout/money` | 8 | Money precision, rounding |
| `checkout/cart-idor` | 9 | Cross-cart IDOR prevention |
| `orders` | 15 | Order lifecycle, cancel, notes |
| `payments` | 14 | Payment create/capture/refund |
| `gateways` | 21 | AES-256-GCM gateway config round-trip |
| `webhooks` | 20 | Per-provider signed fixtures, replay, auto-complete |
| `inventory` | 28 | Warehouses, levels, lots, serials, suppliers |
| `shipping` | 36 | Zones, rates, BobGo mock, collection points, shipments |
| `tax` | 28 | Categories, zones, rates, calculation |
| `discounts` | 40 | All 5 code types, once-per-customer, auto-discounts |
| `wallet` | 14 | Store credits, concurrent adjustments |
| `giftcards` | 16 | Gift card CRUD, transactions, concurrency |
| `customer-auth` | 21 | Register/login/sessions/OAuth/magic-link |
| `cross-org` | 3 | IDOR / cross-tenant isolation |
| `b2b` | 24 | Companies, quotes, purchase orders |
| `subscriptions` | 17 | Plan + subscription lifecycle |
| `returns` | 12 | RMA request, refund/exchange/restock |
| `digital` | 7 | Digital files, tokenized download links |
| `engagement` | 14 | Wishlists, abandoned cart recovery |
| `feeds` | 19 | Google Shopping XML, Facebook Catalog |
| `integrations` | 19 | Integration CRUD, pixels, notifications |
| `notifications` | 14 | Notification providers, dispatch |
| `mcp` | (see seed) | MCP tool conformance |
| `acp` | 21 | ACP adapter endpoints, idempotency, error mapping |
| `mandates` | 26 | Agent CRUD, mandate chain, ed25519, spend limits |
| `search` | 18 | Hybrid semantic + full-text, RRF, filters |
| `seed` | 31 | Demo store seed + full MCP purchase flow |

---

## Simulated time for billing (billingsim)

The billing engine injects a `Clock` interface (`backend/src/clock.ts`):

```typescript
export interface Clock { now(): Date; }
export class SystemClock implements Clock { now() { return new Date(); } }
export class SimClock implements Clock { /* scale wall time by N */ }
```

For billing tests, `SimClock` compresses wall time: when `scale = 86400`, one
real second equals one simulated day.

The compression factor is set via environment variables:

```env
BILLING_SIM_ENABLED=true
BILLING_SIM_DAY_SECONDS=1    # 1 real second = 1 simulated day
```

With `BILLING_SIM_DAY_SECONDS=1`, a 30-day billing cycle completes in 30 real
seconds. This makes the full lifecycle (subscribe → renew → fail → grace →
downgrade) testable in CI.

**Safety guard** — if `BILLING_SIM_ENABLED=true` and `APP_ENV=production`, the
server refuses to start. This prevents accidentally running with a compressed
clock in production.

**Using SimClock in a billing test:**

```typescript
import { SimClock } from '../../src/clock.js';

const clock = new SimClock(
  new Date('2026-01-01'),  // simulation start
  86400                    // 1 real second = 1 day
);

// Inject into the billing engine
const engine = new BillingEngine({ pool, clock });

// Advance simulated time without waiting
clock.advance(30 * 24 * 60 * 60 * 1000); // advance 30 simulated days
```

The `advance(ms)` method moves the epoch forward, making `clock.now()` return a
later simulated date immediately — no sleeps required in tests.

---

## Environment flags for tests

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Required for all integration suites |
| `JWT_SECRET` | Required for suites that mint management JWTs |
| `AUTH_SECRETS_KEY` | Optional; tests work without it (plaintext passthrough) |
| `BILLING_SIM_ENABLED` | Set `true` to enable SimClock in billing suites |
| `BILLING_SIM_DAY_SECONDS` | Simulated seconds per billing day (default: 86400 = real day) |
| `VITEST_LOG=1` | Enable Fastify + pg log output during tests |

---

## Unit tests

Colocated unit tests (`*.test.ts` next to the source file) cover:

- Money math (numeric string safety, no float arithmetic)
- Proration helpers
- AES-256-GCM secrets round-trip
- Webhook signature verifiers (Stripe / Paystack / Razorpay / Xendit with fixture payloads)
- billingsim math

Run with `pnpm test` (all) or `vitest run --reporter=verbose` from the
`backend/` directory.
