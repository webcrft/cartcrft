/**
 * screenshots.ts — Full-page screenshot capture for docs / README.
 *
 * Captured shots (all saved to docs/screenshots/):
 *   Site:          landing.png, pricing.png, compare.png, docs.png
 *   Dashboard:     dashboard-overview.png, dashboard-products.png, dashboard-orders.png
 *   Super-admin:   superadmin-analytics.png
 *   Checkout:      checkout.png   (may be skipped if no payment provider is configured)
 *
 * Run:  pnpm --filter @cartcrft/e2e screenshots
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

async function snap(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: ss(name), fullPage: true });
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
  await snap(page, 'landing.png');
});

test('site: pricing', async ({ page }) => {
  await page.goto('/pricing');
  await snap(page, 'pricing.png');
});

test('site: compare', async ({ page }) => {
  await page.goto('/compare');
  await snap(page, 'compare.png');
});

test('site: docs', async ({ page }) => {
  await page.goto('/docs');
  await snap(page, 'docs.png');
});

// ── Dashboard screenshots ─────────────────────────────────────────────────────

test('dashboard: overview', async ({ page }) => {
  await loginToDashboard(page);
  await page.waitForLoadState('networkidle');
  await snap(page, 'dashboard-overview.png');
});

test('dashboard: products', async ({ page }) => {
  await loginToDashboard(page);

  // Navigate to products
  const link = page.locator('a', { hasText: /Products/i }).first();
  if ((await link.count()) > 0) {
    await link.click();
  } else {
    await page.goto('/dashboard/products');
  }
  await snap(page, 'dashboard-products.png');
});

test('dashboard: orders', async ({ page }) => {
  await loginToDashboard(page);

  const link = page.locator('a', { hasText: /Orders/i }).first();
  if ((await link.count()) > 0) {
    await link.click();
  } else {
    await page.goto('/dashboard/orders');
  }
  await snap(page, 'dashboard-orders.png');
});

// ── Super-admin screenshots ───────────────────────────────────────────────────

test('superadmin: analytics', async ({ page }) => {
  await loginToSuperAdmin(page);
  await page.waitForLoadState('networkidle');
  await snap(page, 'superadmin-analytics.png');
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
  await snap(page, 'checkout.png');
});
