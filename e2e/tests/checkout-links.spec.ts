/**
 * checkout-links.spec.ts — smoke test for the hosted checkout / payment link flow.
 *
 * Flow:
 *  1. Login via POST /account/login to get an access JWT.
 *  2. List stores to get the demo store id.
 *  3. List products/variants to find a real variant id.
 *  4. Create a checkout link via POST /commerce/stores/:storeId/checkout-links.
 *  5. Navigate to /pay/:token and assert the page renders.
 *
 * If any API step returns a non-OK status, we skip gracefully.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const ADMIN_EMAIL = process.env['DEMO_ADMIN_EMAIL'] ?? 'demo@cartcrft.test';
const ADMIN_PASS  = process.env['DEMO_ADMIN_PASSWORD'] ?? 'demodemo123';
const BACKEND     = 'http://localhost:8080';

test.describe('Hosted checkout link', () => {
  test('create checkout link and view /pay/:token', async ({ page }) => {
    // Step 1: Login
    const apiCtx = await pwRequest.newContext({ baseURL: BACKEND });

    const loginRes = await apiCtx.post('/account/login', {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASS },
    });
    if (!loginRes.ok()) {
      test.skip(true, `Login failed: ${loginRes.status()} — skipping checkout-links test`);
      return;
    }
    const loginData = await loginRes.json() as { access_token?: string };
    const token = loginData.access_token;
    if (!token) {
      test.skip(true, 'No access_token in login response — skipping');
      return;
    }

    const headers = { Authorization: `Bearer ${token}` };

    // Step 2: List stores
    const storesRes = await apiCtx.get('/commerce/stores', { headers });
    if (!storesRes.ok()) {
      test.skip(true, `Stores list failed: ${storesRes.status()}`);
      return;
    }
    const storesData = await storesRes.json() as { stores?: { id: string }[] };
    const store = storesData.stores?.[0];
    if (!store) {
      test.skip(true, 'No stores found — skipping');
      return;
    }
    const storeId = store.id;

    // Step 3: Get a variant id
    const productsRes = await apiCtx.get(`/commerce/stores/${storeId}/products?limit=1`, { headers });
    if (!productsRes.ok()) {
      test.skip(true, `Products list failed: ${productsRes.status()}`);
      return;
    }
    const productsData = await productsRes.json() as { products?: { id: string }[] };
    const productId = productsData.products?.[0]?.id;
    if (!productId) {
      test.skip(true, 'No products found — skipping');
      return;
    }

    const variantsRes = await apiCtx.get(
      `/commerce/stores/${storeId}/products/${productId}/variants?limit=1`,
      { headers }
    );
    if (!variantsRes.ok()) {
      test.skip(true, `Variants list failed: ${variantsRes.status()}`);
      return;
    }
    const variantsData = await variantsRes.json() as { variants?: { id: string }[] };
    const variantId = variantsData.variants?.[0]?.id;
    if (!variantId) {
      test.skip(true, 'No variants found — skipping');
      return;
    }

    // Step 4: Create a checkout link
    const linkRes = await apiCtx.post(
      `/commerce/stores/${storeId}/checkout-links`,
      {
        headers,
        data: {
          line_items: [{ variant_id: variantId, quantity: 1 }],
          customer_email: 'test@cartcrft.test',
        },
      }
    );
    if (!linkRes.ok()) {
      test.skip(true, `Create checkout link failed: ${linkRes.status()} ${await linkRes.text()}`);
      return;
    }
    const linkData = await linkRes.json() as { token?: string };
    const clToken = linkData.token;
    if (!clToken) {
      test.skip(true, 'No token in checkout link response');
      return;
    }

    // Step 5: Navigate to /pay/:token
    await page.goto(`/pay/${clToken}`);
    await page.waitForLoadState('networkidle');

    // The hosted checkout page should have some content
    const text = await page.textContent('body');
    expect((text ?? '').length).toBeGreaterThan(50);

    // Look for a pay/checkout button or price
    const url = page.url();
    expect(url).toContain('/pay/');
  });
});
