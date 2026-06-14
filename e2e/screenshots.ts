/**
 * screenshots.ts — High-quality retina screenshot capture for docs / README.
 *
 * Prerequisites: web dev server on :4321, backend on :8080.
 * Run:  pnpm --filter @cartcrft/e2e run screenshots
 *   or: pnpm screenshots  (from repo root — seeds data first)
 *
 * Captured shots (all saved to docs/screenshots/):
 *   Site:          landing.png, pricing.png, compare.png, docs.png
 *   Dashboard:     dashboard-overview.png, dashboard-products.png, dashboard-orders.png
 *   Super-admin:   superadmin-analytics.png
 *   Checkout:      checkout.png   (skipped if no payment provider is configured)
 *
 * Quality guarantees:
 *   • deviceScaleFactor: 2 (retina-crisp at every pixel)
 *   • Scrollbars hidden via CSS injection
 *   • networkidle + page-specific data sentinel before capture
 *   • Short settle timeout after networkidle for reveal animations
 *   • Above-the-fold clip where full-page is too tall / awkward
 */

import { test, expect, request as pwRequest } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load creds from repo-root .env
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const SCREENSHOTS_DIR = path.resolve(process.cwd(), '../docs/screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const ADMIN_EMAIL = process.env['DEMO_ADMIN_EMAIL']         ?? 'demo@cartcrft.test';
const ADMIN_PASS  = process.env['DEMO_ADMIN_PASSWORD']      ?? 'demodemo123';
const SA_EMAIL    = process.env['DEMO_SUPERADMIN_EMAIL']    ?? 'ops@cartcrft.test';
const SA_PASS     = process.env['DEMO_SUPERADMIN_PASSWORD'] ?? 'opsopsops123';
const BACKEND     = 'http://localhost:8080';

function ss(name: string): string {
  return path.join(SCREENSHOTS_DIR, name);
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Hide scrollbars globally so they never appear in screenshots. */
async function hideScrollbars(page: import('@playwright/test').Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        scrollbar-width: none !important;
      }
      ::-webkit-scrollbar { display: none !important; }
    `,
  });
}

/**
 * Core snap helper.
 *
 * After networkidle, waits for `sentinel` (a CSS selector that should NOT be
 * "Loading…" text — use a real data element) to become visible, then waits
 * `settleMs` for reveal animations before capturing.
 *
 * Pass `clip` (in CSS pixels — Playwright scales internally for deviceScaleFactor)
 * to capture a clean above-the-fold region instead of the full page.
 */
async function snap(
  page: import('@playwright/test').Page,
  name: string,
  opts: {
    sentinel?: string;
    settleMs?: number;
    clip?: { x: number; y: number; width: number; height: number };
  } = {},
): Promise<void> {
  const { sentinel, settleMs = 400, clip } = opts;

  await page.waitForLoadState('networkidle');

  if (sentinel) {
    await page.waitForSelector(sentinel, { state: 'visible', timeout: 30_000 });
  }

  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }

  await hideScrollbars(page);

  const screenshotOpts: Parameters<typeof page.screenshot>[0] = {
    path: ss(name),
    fullPage: !clip,
    ...(clip ? { clip } : {}),
  };

  await page.screenshot(screenshotOpts);
  console.log(`  ✓ ${name}`);
}

async function loginToDashboard(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/dashboard/login');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
}

async function loginToSuperAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/superadmin/login');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type="email"]').fill(SA_EMAIL);
  await page.locator('input[type="password"]').fill(SA_PASS);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
}

// ── Site screenshots ──────────────────────────────────────────────────────────

test('site: landing', async ({ page }) => {
  await page.goto('/');
  // Wait for the hero headline to be visible — proves the JS bundle hydrated
  await snap(page, 'landing.png', {
    sentinel: '.hero-headline, h1, [class*="hero"]',
    settleMs: 600,
    // Capture the hero + stats band — the most impactful above-the-fold slice
    clip: { x: 0, y: 0, width: 1512, height: 900 },
  });
});

test('site: pricing', async ({ page }) => {
  await page.goto('/pricing');
  await snap(page, 'pricing.png', {
    sentinel: '[class*="pricing"], h1, main',
    settleMs: 400,
  });
});

test('site: compare', async ({ page }) => {
  await page.goto('/compare');
  await snap(page, 'compare.png', {
    sentinel: 'table, [class*="compare"], h1',
    settleMs: 400,
  });
});

test('site: docs', async ({ page }) => {
  await page.goto('/docs');
  await snap(page, 'docs.png', {
    sentinel: 'nav, [class*="sidebar"], h1, main',
    settleMs: 400,
  });
});

// ── Dashboard screenshots ─────────────────────────────────────────────────────

test('dashboard: overview', async ({ page }) => {
  await loginToDashboard(page);
  // Wait until a metric card value is rendered (not the Spinner).
  // The metric cards render a large number — the .font-display class on the
  // value `<p>` is the best stable sentinel that proves data loaded.
  await snap(page, 'dashboard-overview.png', {
    sentinel: '.grid [class*="font-display"], .grid [class*="tabular-nums"]',
    settleMs: 500,
    clip: { x: 0, y: 0, width: 1512, height: 900 },
  });
});

test('dashboard: products', async ({ page }) => {
  await loginToDashboard(page);

  const link = page.locator('a', { hasText: /Products/i }).first();
  if ((await link.count()) > 0) {
    await link.click();
  } else {
    await page.goto('/dashboard/products');
  }

  // Wait for at least one product row or the empty-state — not the Spinner
  await snap(page, 'dashboard-products.png', {
    sentinel: 'table tr:nth-child(2), [class*="EmptyState"], [class*="empty-state"]',
    settleMs: 400,
    clip: { x: 0, y: 0, width: 1512, height: 900 },
  });
});

test('dashboard: orders', async ({ page }) => {
  await loginToDashboard(page);

  const link = page.locator('a', { hasText: /Orders/i }).first();
  if ((await link.count()) > 0) {
    await link.click();
  } else {
    await page.goto('/dashboard/orders');
  }

  // Wait for an order row or empty-state
  await snap(page, 'dashboard-orders.png', {
    sentinel: 'table tr:nth-child(2), [class*="EmptyState"], [class*="empty-state"]',
    settleMs: 400,
    clip: { x: 0, y: 0, width: 1512, height: 900 },
  });
});

// ── Super-admin screenshots ───────────────────────────────────────────────────

test('superadmin: analytics', async ({ page }) => {
  await loginToSuperAdmin(page);
  // Wait for a StatCard value to be rendered — any element with a large
  // tabular number proves the analytics data came back from the API.
  await snap(page, 'superadmin-analytics.png', {
    sentinel: '[class*="tabular-nums"], [class*="font-display"], svg path',
    settleMs: 600,
    clip: { x: 0, y: 0, width: 1512, height: 900 },
  });
});

// ── Checkout screenshot ───────────────────────────────────────────────────────

test('checkout: hosted pay page', async ({ page }) => {
  // Get a checkout link token via API
  const apiCtx = await pwRequest.newContext({ baseURL: BACKEND });

  const loginRes = await apiCtx.post('/account/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASS },
  });
  if (!loginRes.ok()) {
    console.log('  ⚠ checkout screenshot skipped: login failed');
    return;
  }
  const loginData = await loginRes.json() as { access_token?: string };
  const token = loginData.access_token;
  if (!token) {
    console.log('  ⚠ checkout screenshot skipped: no access_token');
    return;
  }

  const headers = { Authorization: `Bearer ${token}` };

  const storesRes = await apiCtx.get('/commerce/stores', { headers });
  if (!storesRes.ok()) { console.log('  ⚠ checkout screenshot skipped: stores list failed'); return; }
  const storesData = await storesRes.json() as { stores?: { id: string }[] };
  const storeId = storesData.stores?.[0]?.id;
  if (!storeId) { console.log('  ⚠ checkout screenshot skipped: no store'); return; }

  const productsRes = await apiCtx.get(`/commerce/stores/${storeId}/products?limit=1`, { headers });
  if (!productsRes.ok()) { console.log('  ⚠ checkout screenshot skipped: products failed'); return; }
  const productsData = await productsRes.json() as { products?: { id: string }[] };
  const productId = productsData.products?.[0]?.id;
  if (!productId) { console.log('  ⚠ checkout screenshot skipped: no product'); return; }

  const variantsRes = await apiCtx.get(`/commerce/stores/${storeId}/products/${productId}/variants?limit=1`, { headers });
  if (!variantsRes.ok()) { console.log('  ⚠ checkout screenshot skipped: variants failed'); return; }
  const variantsData = await variantsRes.json() as { variants?: { id: string }[] };
  const variantId = variantsData.variants?.[0]?.id;
  if (!variantId) { console.log('  ⚠ checkout screenshot skipped: no variant'); return; }

  const linkRes = await apiCtx.post(`/commerce/stores/${storeId}/checkout-links`, {
    headers,
    data: { line_items: [{ variant_id: variantId, quantity: 1 }], customer_email: 'screenshot@cartcrft.test' },
  });
  if (!linkRes.ok()) {
    console.log(`  ⚠ checkout screenshot skipped: create link failed (${linkRes.status()})`);
    return;
  }
  const linkData = await linkRes.json() as { token?: string };
  const clToken = linkData.token;
  if (!clToken) { console.log('  ⚠ checkout screenshot skipped: no token'); return; }

  await page.goto(`/pay/${clToken}`);

  // Wait for the actual line items to render — .pay-line is only present once
  // the checkout link data has loaded (never in the skeleton Loading state).
  await snap(page, 'checkout.png', {
    sentinel: '.pay-line, .pay-total-row--grand',
    settleMs: 300,
  });
});
