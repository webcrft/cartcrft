import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 60_000,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4321',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testDir: './tests',
      testMatch: /.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'screenshots',
      testDir: '.',
      testMatch: /screenshots\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // Retina-quality captures: 2× pixel density, clean 16:10 viewport,
        // forced dark scheme to match the Agentic Terminal aesthetic.
        deviceScaleFactor: 2,
        viewport: { width: 1512, height: 982 },
        colorScheme: 'dark',
      },
    },
  ],
});
