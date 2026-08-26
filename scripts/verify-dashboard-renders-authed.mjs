/**
 * LOAD THE STAFF DASHBOARD WITH A REAL SESSION AND SEE WHETHER IT RENDERS. STAGING ONLY.
 *
 * WHY THIS EXISTS. On 2026-08-26 `/api/version` answered a healthy SHA 20/20 on all four
 * production hostnames while `flashtap.app/dashboard` served "Application error: a client-side
 * exception has occurred" to staff. A version string proves a worker deployed. It does not prove a
 * page renders, and the two were telling different stories for twenty-six hours.
 *
 * The unauthenticated check cannot answer it either: `/dashboard` redirects to `/signin`, so the
 * component never renders and a clean run means nothing. That is why this one signs in.
 *
 * IT MINTS ITS OWN STAFF USER AND DELETES IT AFTERWARDS, following the pattern
 * `tests/e2e/dashboard-overdue-requests.spec.ts` already uses — including the `public.users` mirror
 * row, because `restaurant_users.user_id` is FK'd to `public.users` rather than to `auth.users`.
 * Teardown runs in `finally`, so a failed assertion still cleans up.
 *
 * STAGING ONLY, ENFORCED. It refuses unless the Supabase URL carries the staging ref. Minting a
 * staff user is a write, and a write against production to satisfy a read-only question would be
 * the wrong trade in any direction.
 *
 * WHAT IT ASSERTS
 *   1. the page does NOT land on /signin       (otherwise nothing was tested — reported, not passed)
 *   2. zero uncaught page errors
 *   3. no "Application error" / "is not defined" anywhere in the rendered text or console
 *   4. and a POSITIVE CONTROL: recognisable dashboard chrome is actually on screen, so a blank
 *      2xx with no errors cannot pass as a healthy render
 *
 * Marker: DASHBOARD_AUTHED_RENDER_OK
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const WORKER = process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF)) {
  console.error(`REFUSING: this mints a user and must run against STAGING only. Got: ${url}`)
  process.exit(1)
}
if (!key) {
  console.error('REFUSING: SUPABASE_SERVICE_ROLE_KEY is unset.')
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS  ' : '*** FAIL ***  '}${label}${detail ? '   ' + detail : ''}`)
}

async function main() {
  const { data: rests, error: rErr } = await db.from('restaurants').select('id,name').limit(1)
  if (rErr || !rests?.length) throw new Error(`no restaurant to attach to: ${rErr?.message}`)
  const restaurantId = rests[0].id
  console.log(`staging restaurant: ${rests[0].name} (${String(restaurantId).slice(0, 8)})`)

  const email = `probe-dashboard-render-${randomUUID().slice(0, 8)}@flashtap-test.invalid`
  const password = `Pw-${randomUUID()}`
  let userId = null

  try {
    const { data: created, error: uErr } = await db.auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (uErr || !created?.user) throw new Error(`create staff user: ${uErr?.message}`)
    userId = created.user.id

    // public.users mirror — restaurant_users.user_id is FK'd here, not to auth.users.
    const { error: mErr } = await db.from('users')
      .insert({ id: userId, email, full_name: 'dashboard render probe', avatar_url: null })
    if (mErr) throw new Error(`public.users mirror: ${mErr.message}`)

    const { error: roleErr } = await db.from('restaurant_users')
      .insert({ restaurant_id: restaurantId, user_id: userId, role: 'owner' })
    if (roleErr) throw new Error(`grant membership: ${roleErr.message}`)

    const browser = await chromium.launch()
    const page = await browser.newPage()
    const consoleErrors = []
    const pageErrors = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) })
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)))

    try {
      await page.goto(`${WORKER}/signin`, { waitUntil: 'networkidle', timeout: 45000 })
      await page.fill('input[type="email"]', email)
      await page.fill('input[type="password"]', password)
      await page.click('button[type="submit"]')
      await page.waitForURL((u) => !u.pathname.includes('/signin'), { timeout: 45000 }).catch(() => {})
      await page.goto(`${WORKER}/dashboard`, { waitUntil: 'networkidle', timeout: 45000 })
      // Client-side exceptions surface after hydration; networkidle does not wait for it.
      await page.waitForTimeout(5000)

      const finalUrl = page.url()
      const bodyText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 1200)
      const all = [...consoleErrors, ...pageErrors].join('\n')

      console.log(`\n  final url    ${finalUrl}`)
      console.log(`  page errors  ${pageErrors.length}`)
      for (const e of pageErrors.slice(0, 5)) console.log(`    ! ${e}`)
      for (const e of consoleErrors.slice(0, 6)) console.log(`    - ${e}`)
      console.log(`  body starts  ${JSON.stringify(bodyText.slice(0, 240))}\n`)

      const onSignin = finalUrl.includes('/signin')
      check('signed in — the dashboard component actually rendered', !onSignin,
        onSignin ? 'still on /signin, so NOTHING below was tested' : finalUrl)
      check('no uncaught page errors', pageErrors.length === 0, `${pageErrors.length}`)
      check('no "Application error" on screen', !bodyText.includes('Application error'))
      check('no "is not defined" anywhere', !all.includes('is not defined') && !bodyText.includes('is not defined'))
      check('no STRANDED_CLAIM_COPY reference', !all.includes('STRANDED_CLAIM_COPY') && !bodyText.includes('STRANDED_CLAIM_COPY'))

      /*
       * POSITIVE CONTROL. Every assertion above is a NEGATIVE — "no error". A blank page with a
       * 200 and a clean console satisfies all of them, and that is exactly what a silently failing
       * render looks like. So something recognisable from the dashboard must be on screen.
       */
      const chrome = ['Orders', 'Tables', 'Dashboard', 'Live', 'Menu']
      const seen = chrome.filter((c) => bodyText.includes(c))
      check('CONTROL: dashboard chrome is on screen', seen.length > 0,
        seen.length ? `found: ${seen.join(', ')}` : 'the page is blank — a clean console proves nothing')
    } finally {
      await browser.close()
    }
  } finally {
    if (userId) {
      await db.from('restaurant_users').delete().eq('user_id', userId)
      await db.from('users').delete().eq('id', userId)
      await db.auth.admin.deleteUser(userId).catch(() => {})
      console.log(`\n  torn down: ${email}`)
    }
  }

  console.log('')
  if (failures) {
    console.log(`*** ${failures} ASSERTION(S) FAILED ***`)
    process.exitCode = 1
  } else {
    console.log('DASHBOARD_AUTHED_RENDER_OK')
  }
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exit(1) })
