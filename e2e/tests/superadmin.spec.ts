/**
 * superadmin.spec.ts — smoke tests for the operator console.
 *
 * Zone: /superadmin*  (React SPA, basename=/superadmin)
 * Login: single form with email + password inputs.
 */
import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const SA_EMAIL = process.env['DEMO_SUPERADMIN_EMAIL'] ?? 'ops@cartcrft.test';
const SA_PASS  = process.env['DEMO_SUPERADMIN_PASSWORD'] ?? 'opsopsops123';

async function loginToSuperAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/superadmin/login');
  await page.waitForLoadState('networkidle');

  await page.locator('input[type="email"]').fill(SA_EMAIL);
  await page.locator('input[type="password"]').fill(SA_PASS);
  await page.locator('button[type="submit"]').click();

  // Wait for redirect away from /login
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 });
}

test.describe('Super-admin console', () => {
  test('unauthenticated /superadmin redirects to login', async ({ page }) => {
    await page.goto('/superadmin');
    await page.waitForURL((url) => url.pathname.includes('/login'));
    expect(page.url()).toContain('/login');
  });

  test('login with superadmin credentials', async ({ page }) => {
    await loginToSuperAdmin(page);
    expect(page.url()).not.toContain('/login');
  });

  test('analytics / dashboard renders with content', async ({ page }) => {
    await loginToSuperAdmin(page);
    await page.waitForLoadState('networkidle');

    const text = await page.textContent('body');
    expect((text ?? '').length).toBeGreaterThan(100);
  });
});
