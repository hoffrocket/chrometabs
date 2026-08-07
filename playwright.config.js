import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  // Each test drives a real Chrome with a persistent profile, so they must not
  // race each other over the same user-data dir.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
