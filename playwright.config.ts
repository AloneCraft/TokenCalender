import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.TOKEN_CALENDAR_TEST_TMP ? `${process.env.TOKEN_CALENDAR_TEST_TMP}/pw-results` : 'test-results',
});
