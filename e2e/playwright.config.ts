import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 30_000,
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
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
