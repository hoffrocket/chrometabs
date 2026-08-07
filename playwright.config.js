import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  // Each test drives a real Chrome with a persistent profile, so they must not
  // race each other over the same user-data dir.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // CI runners are slower and noisier than a laptop; one retry distinguishes a
  // genuine failure from runner timing without hiding a reproducible break.
  retries: process.env.CI ? 1 : 0,
  // Fail the build if a test is accidentally left focused with .only.
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
