/**
 * LOAD /dashboard IN A REAL BROWSER AND SEE WHAT HAPPENS. Read-only.
 *
 * WHY THIS EXISTS. `/api/version` proves a worker deployed. It does not prove a page renders — and
 * on 2026-08-26 the staff dashboard was serving "Application error: a client-side exception has
 * occurred" while `/api/version` answered a perfectly healthy SHA on all four hostnames, 20/20.
 * The version string and the page were telling different stories and only one of them mattered.
 *
 * So this drives Chromium, captures console errors and page exceptions, and reports what the DOM
 * actually contains.
 *
 * WHAT IT CAN AND CANNOT SEE. `/dashboard` is behind staff auth and this harness has no staff
 * session (#178). So it reports the terminal state honestly:
 *
 *   RENDERED    the dashboard shell is on screen
 *   REDIRECTED  bounced to a login surface — the component never rendered, so a clean run here
 *               is NOT evidence the fix works, and the script says so rather than printing OK
 *   CRASHED     Next's default error boundary is showing
 *
 * The distinction matters more than the pass: a REDIRECTED run with no console errors looks
 * identical to a healthy one unless the script refuses to call it a pass.
 *
 * Usage: node scripts/verify-dashboard-renders.mjs <base-url> [...more urls]
 */
import { chromium } from 'playwright'

const URLS = process.argv.slice(2)
if (URLS.length === 0) {
  console.error('usage: node scripts/verify-dashboard-renders.mjs <base-url> [...]')
  process.exit(1)
}

const CRASH_MARKERS = [
  'Application error',
  'client-side exception',
  'is not defined',
  'Minified React error',
]

async function probe(base) {
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  const consoleErrors = []
  const pageErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)))

  const url = `${base.replace(/\/$/, '')}/dashboard`
  let finalUrl = ''
  let bodyText = ''
  let status = 0
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
    status = res?.status() ?? 0
    // Client-side exceptions surface after hydration, which networkidle does not guarantee.
    await page.waitForTimeout(3500)
    finalUrl = page.url()
    bodyText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 600)
  } catch (e) {
    bodyText = `NAVIGATION FAILED: ${String(e.message).slice(0, 200)}`
  }

  await browser.close()

  const all = [...consoleErrors, ...pageErrors].join('\n')
  const crashed = CRASH_MARKERS.some((m) => all.includes(m) || bodyText.includes(m))
  const redirected = Boolean(finalUrl) && !finalUrl.includes('/dashboard')
  const strandedRef = all.includes('STRANDED_CLAIM_COPY') || bodyText.includes('STRANDED_CLAIM_COPY')

  console.log(`\n=== ${url}`)
  console.log(`  http status      ${status}`)
  console.log(`  final url        ${finalUrl || '(none)'}`)
  console.log(`  page errors      ${pageErrors.length}`)
  console.log(`  console errors   ${consoleErrors.length}`)
  if (pageErrors.length) for (const e of pageErrors.slice(0, 5)) console.log(`    ! ${e}`)
  if (consoleErrors.length) for (const e of consoleErrors.slice(0, 5)) console.log(`    - ${e}`)
  console.log(`  STRANDED_CLAIM_COPY mentioned anywhere: ${strandedRef ? 'YES *** the bug ***' : 'no'}`)
  console.log(`  body starts: ${JSON.stringify(bodyText.slice(0, 200))}`)

  const verdict = crashed ? 'CRASHED' : redirected ? 'REDIRECTED' : 'RENDERED'
  console.log(`  VERDICT: ${verdict}`)
  if (verdict === 'REDIRECTED') {
    console.log('    NOT A PASS. The dashboard component never rendered, so this run says nothing')
    console.log('    about whether it works. Needs an authenticated staff session (#178).')
  }
  return { verdict, strandedRef }
}

const results = []
for (const u of URLS) results.push(await probe(u))

console.log('')
const crashed = results.filter((r) => r.verdict === 'CRASHED').length
const rendered = results.filter((r) => r.verdict === 'RENDERED').length
const redirected = results.filter((r) => r.verdict === 'REDIRECTED').length
console.log(`rendered ${rendered}   redirected ${redirected}   crashed ${crashed}`)
if (crashed) {
  console.log('DASHBOARD_CRASHED')
  process.exitCode = 1
} else if (rendered === results.length) {
  console.log('DASHBOARD_RENDERS_OK')
} else {
  console.log('DASHBOARD_INCONCLUSIVE — see the REDIRECTED note above')
  process.exitCode = 2
}
