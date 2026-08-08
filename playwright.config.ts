import { defineConfig, devices } from '@playwright/test'
import { config as loadEnv } from 'dotenv'

/**
 * #178: `.env.test` is loaded HERE, before the config object below is evaluated.
 *
 * It used to be loaded at spec-module import time, which happens after Playwright has already
 * resolved this config — so SUPABASE_URL, the service-role key and the staff password were
 * absent while the config was being built, and anything read from the environment here saw
 * nothing. `override: false` so an explicitly exported value still wins.
 */
loadEnv({ path: '.env.test', override: false })

/**
 * The DEPLOYED staging worker. Correct for the `chromium` project, which tests public
 * unauthenticated pages and should keep working with no setup.
 *
 * It is the WRONG target for the signed-in projects, which exist to exercise local code — and
 * because `.env.test` sets its own `E2E_BASE_URL` to this same URL, it is also what those
 * projects silently got by default. `tests/e2e/local-build.guard.ts` now refuses that case
 * instead of passing against a build nobody changed. See the header there.
 */
const DEPLOYED_STAGING = 'https://flashtap-staging.llosperofficial.workers.dev'
const BASE_URL = process.env.E2E_BASE_URL ?? DEPLOYED_STAGING

/**
 * Four projects.
 *
 *   chromium          — the pre-existing unauthenticated specs, against deployed staging.
 *                       Explicitly ignores the setup file, the guard and staff/, so adding the
 *                       signed-in suite cannot change what it runs.
 *   guard-local-build — refuses a non-local baseURL. `setup` depends on it, `staff` depends on
 *                       `setup`, so both stop before any sign-in happens.
 *   setup             — signs in once per role and writes storageState.
 *   staff             — the signed-in suite, reusing that state.
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
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/auth.setup.ts', '**/local-build.guard.ts', 'staff/**'],
    },
    {
      name: 'guard-local-build',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /local-build\.guard\.ts/,
    },
    {
      name: 'setup',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /auth\.setup\.ts/,
      dependencies: ['guard-local-build'],
    },
    {
      name: 'staff',
      use: { ...devices['Desktop Chrome'] },
      testDir: './tests/e2e/staff',
      dependencies: ['setup'],
    },
  ],
})
