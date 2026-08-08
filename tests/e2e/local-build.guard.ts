/**
 * Issue #178 — the authenticated projects REFUSE to run against a build that is not local.
 *
 * WHY THIS EXISTS
 *
 * `playwright.config.ts` defaults `baseURL` to the DEPLOYED staging worker, and `.env.test`
 * carries the same URL in its own `E2E_BASE_URL`. So `npx playwright test --project=staff` with
 * nothing exported drove deployed staging — a build that already contains the #176 fix — while
 * the branch under test sat unbuilt on disk. Reintroducing the bug locally did not fail the
 * spec. A browser test that cannot catch the bug it was written for is precisely what #178 was
 * filed to prevent, so this is a hard failure rather than a warning.
 *
 * The deployed default is correct and deliberate for the `chromium` project, which tests
 * public, unauthenticated pages. It is only wrong for the signed-in projects, which exist to
 * exercise LOCAL code. Hence a guard scoped to those, not a change to the default.
 *
 * `setup` depends on this project, and `staff` depends on `setup`, so a failure here stops both
 * before a single sign-in happens.
 *
 * There is deliberately NO escape hatch. An override would be used once "just to check
 * something" and then live in someone's shell, which is exactly how the silent version of this
 * bug survived.
 */
import { test, expect } from '@playwright/test'

/** Loopback, or a private LAN range — the addresses a local dev server can actually be on. */
function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
  if (/^10\./.test(hostname)) return true
  if (/^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true
  return false
}

test('the signed-in projects are pointed at a local build', async ({ baseURL, request }) => {
  expect(baseURL, 'baseURL is not set').toBeTruthy()

  const url = new URL(baseURL as string)
  const local = isLocalHost(url.hostname)

  expect(
    local,
    [
      '',
      `REFUSING TO RUN: baseURL is ${baseURL}, which is not a local build.`,
      '',
      'The signed-in projects exist to exercise the code in this working tree. Pointed at the',
      'deployed worker they pass whatever is already shipped, so a bug reintroduced locally would',
      'not fail them — the exact failure mode #178 exists to prevent.',
      '',
      'Start a local server and point the run at it:',
      '',
      '  powershell -File scripts/start-dev-staging.ps1 -Port 3100',
      '  $env:E2E_BASE_URL = "http://<LAN-IP>:3100"',
      '  npx playwright test --project=staff',
      '',
      'The script prints the LAN IP to use. Note that .env.test carries its own E2E_BASE_URL',
      'pointing at the deployed worker, so an explicit export is required.',
      '',
    ].join('\n'),
  ).toBe(true)

  // Reachable, and serving something. Catches the other half of the trap: a browser cannot reach
  // a dev server started from a Bash sandbox, and the resulting timeout looks like a flaky test
  // rather than a server that was never listening on that interface.
  const res = await request.get(baseURL as string, { timeout: 20_000 })
  expect(
    res.status(),
    `baseURL ${baseURL} did not answer 200 — is the dev server running and bound on that address?`,
  ).toBeLessThan(400)
})
