/**
 * dashboard.spec.ts — smoke tests for the merchant admin dashboard.
 *
 * Zone: /dashboard*  (React SPA, basename=/dashboard)
 * Login form uses type="email" + type="password" inputs in "Email & Password" tab (default).
 */
import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const ADMIN_EMAIL = process.env['DEMO_ADMIN_EMAIL'] ?? 'demo@cartcrft.test';
const ADMIN_PASS  = process.env['DEMO_ADMIN_PASSWORD'] ?? 'demodemo123';

// Shared login helper
async function loginToDashboard(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/dashboard/login');
  await page.waitForLoadState('networkidle');

  // Fill email & password (the "Email & Password" mode is active by default)
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.locator('button[type="submit"]').click();

  // Wait for redirect away from /login
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 });
}

test.describe('Dashboard', () => {
  test('unauthenticated /dashboard redirects to login', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL((url) => url.pathname.includes('/login'));
    expect(page.url()).toContain('/login');
  });

  test('login with demo credentials', async ({ page }) => {
    await loginToDashboard(page);
    // Should now be on the dashboard (not login)
    expect(page.url()).not.toContain('/login');
  });

  test('dashboard overview renders after login', async ({ page }) => {
    await loginToDashboard(page);
    await page.waitForLoadState('networkidle');

    // Look for typical dashboard text
    const text = await page.textContent('body');
    expect((text ?? '').length).toBeGreaterThan(100);
  });

  test('navigate to Products page', async ({ page }) => {
    await loginToDashboard(page);
    await page.waitForLoadState('networkidle');

    // Find nav link for Products
    const productsLink = page.locator('a', { hasText: /Products/i }).first();
    const hasProducts = (await productsLink.count()) > 0;
    if (hasProducts) {
      await productsLink.click();
      await page.waitForLoadState('networkidle');
      expect(page.url()).toMatch(/product/i);
    } else {
      // Try navigating directly
      await page.goto('/dashboard/products');
      await page.waitForLoadState('networkidle');
      const text = await page.textContent('body');
      expect((text ?? '').length).toBeGreaterThan(50);
    }
  });

  test('navigate to Orders page', async ({ page }) => {
    await loginToDashboard(page);
    await page.waitForLoadState('networkidle');

    const ordersLink = page.locator('a', { hasText: /Orders/i }).first();
    const hasOrders = (await ordersLink.count()) > 0;
    if (hasOrders) {
      await ordersLink.click();
      await page.waitForLoadState('networkidle');
      expect(page.url()).toMatch(/order/i);
    } else {
      await page.goto('/dashboard/orders');
      await page.waitForLoadState('networkidle');
      const text = await page.textContent('body');
      expect((text ?? '').length).toBeGreaterThan(50);
    }
  });
});
