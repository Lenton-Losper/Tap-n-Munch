/**
 * Throwaway staging investigation ΓÇö auth session handling under network failure.
 * NOT part of the permanent test suite.
 *
 *   STAGING_TEST_EMAIL=... STAGING_TEST_PASSWORD=... npx tsx scripts/investigate-auth-session-bug.ts
 *
 * Optional: STAGING_URL (default flashtap-staging.llosperofficial.workers.dev)
 * Loads NEXT_PUBLIC_SUPABASE_* from .env.test when present (for scenario 2 refresh).
 */
import { chromium, type Page } from '@playwright/test'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const BASE_URL = (
  process.env.STAGING_URL ||
  process.env.STAGING_APP_URL ||
  process.env.E2E_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'
).replace(/\/$/, '')

const STAGING_TEST_EMAIL = process.env.STAGING_TEST_EMAIL?.trim()
const STAGING_TEST_PASSWORD = process.env.STAGING_TEST_PASSWORD

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''

type ConsoleEntry = {
  ts: string
  type: string
  text: string
}

type UiState = 'normal' | 'repair_screen' | 'signin_redirect' | 'unknown'

function ts(): string {
  return new Date().toISOString()
}

function attachConsoleTap(page: Page, sink: ConsoleEntry[]) {
  page.on('console', (msg) => {
    const entry = {
      ts: ts(),
      type: msg.type(),
      text: msg.text(),
    }
    sink.push(entry)
    process.stdout.write(`[${entry.ts}] [browser:${entry.type}] ${entry.text}\n`)
  })
}

function attachNavigationTap(page: Page) {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    console.log(`[${ts()}] [navigation] ${frame.url()}`)
  })
}

function filterAuthLogs(entries: ConsoleEntry[]): ConsoleEntry[] {
  return entries.filter(
    (e) =>
      e.text.includes('[AUTH_EVENT]') ||
      e.text.includes('[AuthProvider]') ||
      e.text.includes('AUTH_EVENT') ||
      e.text.includes('AuthProvider'),
  )
}

function parseAuthEvents(entries: ConsoleEntry[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    if (!entry.text.includes('[AUTH_EVENT]') && !entry.text.includes('AUTH_EVENT')) continue
    const jsonStart = entry.text.indexOf('{')
    if (jsonStart === -1) {
      events.push({ raw: entry.text, ts: entry.ts })
      continue
    }
    try {
      events.push({ ts: entry.ts, ...(JSON.parse(entry.text.slice(jsonStart)) as object) })
    } catch {
      events.push({ raw: entry.text, ts: entry.ts })
    }
  }
  return events
}

async function detectUiState(page: Page): Promise<UiState> {
  const url = page.url()
  if (/\/signin(?:\?|$|\/)/i.test(url)) return 'signin_redirect'

  const repairHeading = page.getByRole('heading', { name: /account data missing/i })
  if (await repairHeading.isVisible().catch(() => false)) return 'repair_screen'

  const repairButton = page.getByRole('button', { name: /repair my account/i })
  if (await repairButton.isVisible().catch(() => false)) return 'repair_screen'

  if (/\/stock/i.test(url) || /\/dashboard/i.test(url)) return 'normal'

  return 'unknown'
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/signin`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: /email/i }).fill(email)
  await page.getByRole('textbox', { name: /password/i }).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
  await page.getByRole('heading', { name: /dashboard/i }).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(5000)
  console.log(`[${ts()}] [script] signed in URL=${page.url()}`)
}

async function navigateToReceiveViaUi(page: Page) {
  const stockLink = page.getByRole('link', { name: /^stock$/i })
  await stockLink.waitFor({ state: 'visible', timeout: 20_000 })
  await stockLink.click()
  await page.waitForURL(/\/stock(?:\?|$|\/)/i, { timeout: 20_000 })
  console.log(`[${ts()}] [script] stock overview URL=${page.url()}`)

  const receiveLink = page.getByRole('link', { name: /receive delivery/i })
  await receiveLink.waitFor({ state: 'visible', timeout: 20_000 })
  await receiveLink.click()
  await page.waitForURL(/\/stock\/receive/i, { timeout: 20_000 })
  console.log(`[${ts()}] [script] receive page URL=${page.url()}`)
}

async function fillReceiveForm(page: Page) {
  await navigateToReceiveViaUi(page)

  if (!/\/stock\/receive/i.test(page.url())) {
    const bodySnippet = (await page.textContent('body'))?.slice(0, 500)
    throw new Error(
      `Expected /stock/receive but at ${page.url()}. Body snippet: ${bodySnippet ?? '(empty)'}`,
    )
  }

  const supplier = page.locator('#supplier')
  await supplier.waitFor({ state: 'visible', timeout: 30_000 })
  await supplier.fill(`Investigation Supplier ${Date.now()}`)

  const combobox = page.getByRole('combobox').first()
  await combobox.waitFor({ state: 'visible', timeout: 15_000 })
  await combobox.click()
  const firstOption = page.getByRole('option').first()
  await firstOption.waitFor({ state: 'visible', timeout: 10_000 })
  await firstOption.click()

  const quantity = page.locator('input[type="number"]').first()
  await quantity.fill('1')
}

async function printScenarioSummary(
  label: string,
  entries: ConsoleEntry[],
  page: Page,
  uiState: UiState,
  refreshFailTs?: string,
) {
  const authLogs = filterAuthLogs(entries)
  const authEvents = parseAuthEvents(entries)
  const providerFailures = authLogs.filter(
    (e) =>
      e.text.includes('failed') ||
      e.text.includes('getUser failed') ||
      e.text.includes('loadUserData failed'),
  )

  console.log('\n' + '='.repeat(72))
  console.log(`SCENARIO SUMMARY: ${label}`)
  console.log('='.repeat(72))
  console.log(`Final URL: ${page.url()}`)
  console.log(`Final UI state: ${uiState}`)
  console.log(`Total console lines captured: ${entries.length}`)
  console.log(`Auth-related console lines: ${authLogs.length}`)
  console.log('\n--- [AUTH_EVENT] sequence ---')
  if (authEvents.length === 0) {
    console.log('(none captured)')
  } else {
    for (const ev of authEvents) {
      console.log(JSON.stringify(ev))
    }
  }
  if (refreshFailTs) {
    console.log('\n--- Timestamp deltas (refresh failure → AUTH_EVENT) ---')
    const failMs = Date.parse(refreshFailTs)
    const postFailEvents = authEvents.filter((ev) => {
      const evTs = typeof ev.ts === 'string' ? ev.ts : ''
      return evTs && Date.parse(evTs) >= failMs
    })
    if (postFailEvents.length === 0) {
      console.log(`refresh_fail_at=${refreshFailTs} → (no AUTH_EVENT after failure)`)
    } else {
      for (const ev of postFailEvents) {
        const evTs = String(ev.ts)
        const deltaMs = Date.parse(evTs) - failMs
        console.log(
          `refresh_fail_at=${refreshFailTs} → AUTH_EVENT at ${evTs} (+${deltaMs}ms) event=${ev.event} hasSession=${ev.hasSession} online=${ev.online}`,
        )
      }
    }
  }
  console.log('\n--- [AuthProvider] failure logs ---')
  if (providerFailures.length === 0) {
    console.log('(none captured)')
  } else {
    for (const line of providerFailures) {
      console.log(`[${line.ts}] [${line.type}] ${line.text}`)
    }
  }
  console.log('\n--- All auth-related console lines this window ---')
  if (authLogs.length === 0) {
    console.log('(none captured)')
  } else {
    for (const line of authLogs) {
      console.log(`[${line.ts}] [${line.type}] ${line.text}`)
    }
  }
  console.log('='.repeat(72) + '\n')
}

async function scenario1StockReceiveAbort(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const label = 'Scenario 1 ΓÇö stock receive aborted mid-flight'
  console.log(`\n>>> Starting ${label}\n`)

  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleEntries: ConsoleEntry[] = []
  attachConsoleTap(page, consoleEntries)

  const windowStart = consoleEntries.length

  await signIn(page, STAGING_TEST_EMAIL!, STAGING_TEST_PASSWORD!)
  await fillReceiveForm(page)

  // Abort only server-action / receive POSTs ΓÇö after the form is loaded.
  await page.route('**/*', async (route) => {
    const req = route.request()
    const headers = req.headers()
    const url = req.url()
    const isReceivePost = req.method() === 'POST' && /\/stock\/receive/i.test(url)
    const isServerAction = req.method() === 'POST' && Boolean(headers['next-action'])

    if (isReceivePost || isServerAction) {
      console.log(`[${ts()}] [route] aborting ${req.method()} ${url}`)
      await route.abort()
      return
    }
    await route.continue()
  })

  await page.getByRole('button', { name: /save delivery/i }).click()
  await page.waitForTimeout(5000)

  const uiState = await detectUiState(page)
  const windowEntries = consoleEntries.slice(windowStart)
  await printScenarioSummary(label, windowEntries, page, uiState)

  await context.close()
}

async function scenario2TokenRefreshFail(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  runLabel?: string,
) {
  const label = runLabel
    ? `${runLabel} — Scenario 2 — Supabase token refresh fails`
    : 'Scenario 2 — Supabase token refresh fails'
  console.log(`\n>>> Starting ${label}\n`)

  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleEntries: ConsoleEntry[] = []
  attachConsoleTap(page, consoleEntries)
  attachNavigationTap(page)

  const windowStart = consoleEntries.length
  let refreshFailTs: string | undefined

  await signIn(page, STAGING_TEST_EMAIL!, STAGING_TEST_PASSWORD!)

  await page.route('**/auth/v1/token**', async (route) => {
    refreshFailTs = ts()
    console.log(`[${refreshFailTs}] [route] failing token request ${route.request().url()}`)
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'investigation_forced_token_failure', message: 'simulated 500' }),
    })
  })

  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const refreshResult = await page.evaluate(
    async (args: { supabaseUrl: string; anonKey: string }) => {
      const authCookies = document.cookie
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c.includes('-auth-token'))
      if (authCookies.length === 0) {
        return { ok: false, error: 'no_auth_cookie' }
      }

      const raw = decodeURIComponent(authCookies[0].split('=').slice(1).join('='))
      const json = raw.startsWith('base64-')
        ? JSON.parse(atob(raw.replace(/^base64-/, '')))
        : JSON.parse(raw)
      const refreshToken = json?.refresh_token as string | undefined
      if (!refreshToken) {
        return { ok: false, error: 'no_refresh_token_in_cookies' }
      }

      const tokenRes = await fetch(
        `${args.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        {
          method: 'POST',
          headers: {
            apikey: args.anonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        },
      )
      const body = await tokenRes.text()
      return {
        ok: tokenRes.ok,
        status: tokenRes.status,
        body: body.slice(0, 500),
      }
    },
    { supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
  )

  console.log(`[${ts()}] [script] refreshSession evaluate result:`, JSON.stringify(refreshResult))

  await page.waitForTimeout(5000)

  const uiState = await detectUiState(page)
  const windowEntries = consoleEntries.slice(windowStart)
  await printScenarioSummary(label, windowEntries, page, uiState, refreshFailTs)

  await context.close()
}

/** Slow 3G-ish profile via CDP (no forced request failures). */
async function applySlow3GNetwork(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
    connectionType: 'cellular3g',
  })
  console.log(`[${ts()}] [script] applied slow 3G network emulation via CDP`)
}

async function scenario3SlowNetworkRemount(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  runLabel?: string,
) {
  const label = runLabel
    ? `${runLabel} — Scenario 3 — slow network dashboard remount`
    : 'Scenario 3 — slow network dashboard remount'
  console.log(`\n>>> Starting ${label}\n`)

  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleEntries: ConsoleEntry[] = []
  attachConsoleTap(page, consoleEntries)
  attachNavigationTap(page)

  const windowStart = consoleEntries.length

  await signIn(page, STAGING_TEST_EMAIL!, STAGING_TEST_PASSWORD!)
  await applySlow3GNetwork(page)

  console.log(`[${ts()}] [script] remounting dashboard under slow 3G`)
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(15_000)

  const uiState = await detectUiState(page)
  const windowEntries = consoleEntries.slice(windowStart)
  await printScenarioSummary(label, windowEntries, page, uiState)

  await context.close()
}

async function main() {
  if (!STAGING_TEST_EMAIL || !STAGING_TEST_PASSWORD) {
    throw new Error(
      'Set STAGING_TEST_EMAIL and STAGING_TEST_PASSWORD env vars before running this script.',
    )
  }

  console.log(`[${ts()}] [script] BASE_URL=${BASE_URL}`)
  console.log(`[${ts()}] [script] STAGING_TEST_EMAIL=${STAGING_TEST_EMAIL}`)

  const browser = await chromium.launch({ headless: true })
  const scenarioOnly = process.env.INVESTIGATE_SCENARIO
  const runCount = Math.max(1, parseInt(process.env.INVESTIGATE_RUNS || '1', 10) || 1)

  try {
    if (!scenarioOnly || scenarioOnly === '1') {
      await scenario1StockReceiveAbort(browser)
    }
    if (!scenarioOnly || scenarioOnly === '2') {
      for (let i = 1; i <= runCount; i++) {
        const runLabel = runCount > 1 ? `Run ${i}` : undefined
        if (runCount > 1) {
          console.log('\n' + '#'.repeat(72))
          console.log(`### Scenario 2 ${runLabel} of ${runCount} ###`)
          console.log('#'.repeat(72))
        }
        await scenario2TokenRefreshFail(browser, runLabel)
      }
    }
    if (!scenarioOnly || scenarioOnly === '3') {
      for (let i = 1; i <= runCount; i++) {
        const runLabel = runCount > 1 ? `Run ${i}` : undefined
        if (runCount > 1) {
          console.log('\n' + '#'.repeat(72))
          console.log(`### Scenario 3 ${runLabel} of ${runCount} ###`)
          console.log('#'.repeat(72))
        }
        await scenario3SlowNetworkRemount(browser, runLabel)
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(`[${ts()}] [script] FATAL`, err)
  process.exit(1)
})
