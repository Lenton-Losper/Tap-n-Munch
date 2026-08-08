import { defineConfig, devices } from '@playwright/test'

/**
 * #178: three projects rather than one.
 *
 *   chromium — the pre-existing unauthenticated specs. Unchanged behaviour: it explicitly
 *              ignores the setup file and the authenticated directory, so adding a signed-in
 *              suite cannot alter what it runs.
 *   setup    — signs in once per role and writes storageState (tests/e2e/auth.setup.ts).
 *   staff    — the signed-in suite, reusing that state.
 *
 * `staff` is NOT wired into any deploy gate. A flaky browser suite that blocks deploys gets
 * disabled, and then nothing is covered again — run it on demand until it has a track record.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://flashtap-staging.llosperofficial.workers.dev',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/auth.setup.ts', 'staff/**'],
    },
    {
      name: 'setup',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'staff',
      use: { ...devices['Desktop Chrome'] },
      testDir: './tests/e2e/staff',
      dependencies: ['setup'],
    },
  ],
})
