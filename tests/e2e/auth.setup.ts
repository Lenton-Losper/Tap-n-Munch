/**
 * Issue #178 — the authenticated staff session that browser coverage of the dashboard needs.
 *
 * Every spec that existed before this one was either customer-facing or tested the SIGNED-OUT
 * case: `auth-routes.spec.ts` asserts `/dashboard` bounces to `/signin` and never signs in. So
 * nothing behind `requireTablesPermission` had any browser coverage at all, which is why the
 * #176 bug ("Could not check open orders / object is not iterable") reached staging with a unit
 * test on each side of it and nothing in the middle.
 *
 * This signs in once per role and saves the storage state; the authenticated projects reuse it,
 * so a spec costs one page load rather than one login.
 *
 * CREDENTIALS — READ THIS BEFORE DEBUGGING A LOGIN FAILURE
 *
 * `STAGING_TEST_PASSWORD` in `.env.test` is STALE. Verified against staging directly: it fails
 * with "Invalid login credentials" for all three staff accounts on the test restaurant. The
 * working credential for the owner is `SIGNIN_METHODS_EMAIL_ONLY_PASSWORD`, which is what the
 * fallback chain below prefers. `STAGING_TEST_PASSWORD` is kept last so this starts working
 * again by itself if someone rotates it back.
 *
 * The kitchen account has NO working password in `.env.test` either, so the no-permissions
 * project cannot run. It is skipped LOUDLY rather than quietly passing — see below. Resetting a
 * staging password would be an auth write, which is not this change's to make.
 *
 * Supabase keeps the session in localStorage, which `storageState()` captures alongside cookies,
 * so waiting for the redirect away from /signin is not enough on its own. The check at the end
 * asserts a session token is actually present in the saved state, because a file that merely
 * exists is exactly the kind of green that means nothing.
 */
import { test as setup, expect } from '@playwright/test'
import { config } from 'dotenv'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { STAFF_STORAGE_STATE, NOPERMS_STORAGE_STATE, STAFF_EMAIL, NOPERMS_EMAIL } from './constants'

// Loaded here so the suite works from a bare shell rather than silently depending on whoever
// exported the variables last. `override: false` keeps an explicit shell value winning.
config({ path: '.env.test', override: false })

/** First non-empty value wins. Order is deliberate — see the header. */
function firstPassword(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n]?.trim()
    if (v) return v
  }
  return null
}

export const STAFF_PASSWORD = firstPassword(
  'E2E_STAFF_PASSWORD',
  'SIGNIN_METHODS_EMAIL_ONLY_PASSWORD',
  'STAGING_TEST_PASSWORD',
)

export const NOPERMS_PASSWORD = firstPassword('E2E_NOPERMS_PASSWORD')

/**
 * Signs in through the real form — not by injecting a token — so the fixture exercises the same
 * path a member of staff does. A fixture that forged a session could hide an auth regression and
 * still let every downstream spec pass.
 */
async function signInAndSave(
  page: import('@playwright/test').Page,
  email: string,
  pw: string,
  file: string,
) {
  await page.goto('/signin')

  await page.locator('#email').fill(email)
  await page.locator('#password').fill(pw)
  await page.getByRole('button', { name: /^sign in$/i }).click()

  // Surface a rejected credential as itself. Without this the run just times out on the URL
  // wait below and the real cause ("Invalid login credentials") stays buried in a screenshot.
  const credentialError = page.getByText(/invalid login credentials|failed to sign in/i)
  await expect
    .poll(
      async () => ((await credentialError.count()) > 0 ? 'rejected' : new URL(page.url()).pathname),
      { timeout: 30_000, message: `sign-in did not complete for ${email}` },
    )
    .not.toMatch(/^(\/signin|rejected)$/)

  mkdirSync(dirname(file), { recursive: true })
  await page.context().storageState({ path: file })

  // A storageState file with no session in it would let every later spec fail confusingly.
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toMatch(/access_token|auth-token/i)
}

setup('authenticate as staff with tables:manage', async ({ page }) => {
  expect(
    STAFF_PASSWORD,
    'No staff password available. Set E2E_STAFF_PASSWORD, or restore ' +
      'SIGNIN_METHODS_EMAIL_ONLY_PASSWORD / STAGING_TEST_PASSWORD in .env.test.',
  ).not.toBeNull()
  await signInAndSave(page, STAFF_EMAIL, STAFF_PASSWORD as string, STAFF_STORAGE_STATE)
})

setup('authenticate as staff without tables permissions', async ({ page }) => {
  // Skipped rather than failed, but the reason is printed every run so it cannot be mistaken for
  // coverage that exists. The kitchen account's password is not in .env.test and resetting it
  // would be an auth write.
  setup.skip(
    NOPERMS_PASSWORD === null,
    `No password for ${NOPERMS_EMAIL}. The permission case is NOT COVERED until ` +
      'E2E_NOPERMS_PASSWORD is set. STAGING_TEST_PASSWORD in .env.test is stale for this account.',
  )
  await signInAndSave(page, NOPERMS_EMAIL, NOPERMS_PASSWORD as string, NOPERMS_STORAGE_STATE)
})
