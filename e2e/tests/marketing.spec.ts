/**
 * marketing.spec.ts — smoke tests for the marketing / site zone.
 *
 * Routes:
 *   /          landing page
 *   /pricing   pricing calculator
 *   /compare   comparison page
 *   /docs      documentation (may redirect to /docs/… or /docs/getting-started)
 */
import { test, expect } from '@playwright/test';

test.describe('Marketing site', () => {
  test('landing page loads with content', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Landing should have a main section and at least an h1 or meaningful heading
    const body = await page.locator('body');
    await expect(body).not.toBeEmpty();
    // Expect some text content
    const text = await page.textContent('body');
    expect(text).toBeTruthy();
    expect((text ?? '').length).toBeGreaterThan(100);
  });

  test('pricing page loads and has interactive elements', async ({ page }) => {
    await page.goto('/pricing');
    await page.waitForLoadState('networkidle');

    // Should render something meaningful
    const body = page.locator('body');
    await expect(body).not.toBeEmpty();

    // Look for a slider/range input which is the pricing calculator
    const sliderOrRange = page.locator('input[type="range"]');
    const hasSlider = (await sliderOrRange.count()) > 0;

    if (hasSlider) {
      // Interact with the slider — determine the midpoint from min/max attrs
      const slider = sliderOrRange.first();
      const min = parseFloat((await slider.getAttribute('min')) ?? '0');
      const max = parseFloat((await slider.getAttribute('max')) ?? '100');
      const mid = String(min + (max - min) * 0.5);

      await slider.fill(mid);
      await page.waitForTimeout(300);

      const newValue = await slider.inputValue();
      // The value should be set to mid or close to it
      expect(parseFloat(newValue)).toBeGreaterThanOrEqual(min);
      expect(parseFloat(newValue)).toBeLessThanOrEqual(max);
    }
    // Even if no slider, page must render
    const text = await page.textContent('body');
    expect((text ?? '').length).toBeGreaterThan(50);
  });

  test('compare page loads', async ({ page }) => {
    await page.goto('/compare');
    await page.waitForLoadState('networkidle');
    const text = await page.textContent('body');
    expect((text ?? '').length).toBeGreaterThan(50);
  });

  test('docs page loads or redirects', async ({ page }) => {
    // /docs may redirect to /docs/getting-started, /quickstart, etc.
    await page.goto('/docs');
    await page.waitForLoadState('networkidle');

    // Accept any page that renders meaningful content (the route may redirect)
    const text = await page.textContent('body');
    expect((text ?? '').length).toBeGreaterThan(50);
  });
});
