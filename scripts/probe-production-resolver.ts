/**
 * PRODUCTION BEFORE/AFTER, READ-ONLY.
 *
 * There is no way to stand up a second production server, so the baseline has to be captured from
 * production ITSELF before the deploy and compared with the same capture after. Run:
 *
 *   MODE=before ... > before.json     (while flashtap.app still serves 26acbda)
 *   MODE=after  ... > after.json      (once /api/version reports the new SHA)
 *   MODE=compare
 *
 * STRICTLY READ-ONLY. Only GETs, and deliberately NOT /api/auth/select-context, which would move
 * a real person's active restaurant on a trading system. Every request is cache-busted.
 *
 * Sessions are minted with the production service-role key via generateLink + verifyOtp rather
 * than passwords, which are not in this environment and must not be.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const MODE = process.env.MODE || 'before'
const HOST = process.env.PROD_HOST || 'https://flashtap.app'
const OUT = process.env.OUT || `prod-${MODE}.json`

const env: Record<string, string> = {}
for (const line of readFileSync(
  'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local',
  'utf8',
).split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
if (!URL_ || !URL_.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error(`REFUSING: not the production project -- ${URL_}`)
}

const db = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** flashtapapp2 holds Riviera + Chownow Nedbank -- the account that saw the 409. */
const MULTI_EMAIL = 'flashtapapp2@gmail.com'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
/** flashtaptestacc1 holds FNB ChowNow only -- the single-restaurant shape ChowNow staff have. */
const SINGLE_EMAIL = 'flashtaptestacc1@gmail.com'
const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'

/** A SIX-MONTH window 500s on production TODAY, on 26acbda, for reasons unrelated to this
 *  change (narrower windows return 200 with the same data). Left wide, this control would have
 *  compared 500 to 500 and called it "identical" -- a vacuous pass over a broken endpoint.
 *  Narrow enough to return real orders, wide enough to contain them. */
const WINDOW = '&startDate=2026-08-01&endDate=2026-08-20'

async function tokenFor(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data?.properties?.hashed_token) {
    throw new Error(`could not mint a session for ${email}: ${error?.message}`)
  }
  const anon = createClient(URL_!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data: session, error: vErr } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  })
  if (vErr || !session.session) throw new Error(`verifyOtp failed for ${email}: ${vErr?.message}`)
  return session.session.access_token
}

function routesFor(restaurantId: string): string[] {
  return [
    '/api/auth/role',
    '/api/auth/contexts',
    '/api/admin/setup-status',
    '/api/admin/features',
    '/api/admin/staff',
    '/api/admin/terminals/list',
    '/api/admin/restaurant-roles',
    `/api/orders/history?restaurantId=${restaurantId}${WINDOW}`,
  ]
}

function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([k]) => !['timestamp', 'generatedAt', 'requestId'].includes(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, norm(val)]),
      )
    }
    return x
  }
  return JSON.stringify(norm(v))
}

async function capture() {
  const version = await (await fetch(`${HOST}/api/version?cb=${Date.now()}`)).text()
  console.log(`host ${HOST} serving ${version.trim()}`)

  const out: Record<string, { status: number; body: string }> = { __version: { status: 0, body: version.trim() } }

  for (const [label, email, restaurantId] of [
    ['multi', MULTI_EMAIL, RIVIERA],
    ['single', SINGLE_EMAIL, FNB_CHOWNOW],
  ] as const) {
    const token = await tokenFor(email)
    for (const route of routesFor(restaurantId)) {
      const sep = route.includes('?') ? '&' : '?'
      const res = await fetch(`${HOST}${route}${sep}cb=${Date.now()}${Math.random()}`, {
        headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
      })
      const text = await res.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      out[`${label} ${route}`] = { status: res.status, body: canonical(body) }
      console.log(`  ${label.padEnd(6)} ${String(res.status).padEnd(4)} ${route.slice(0, 76)}`)
    }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${OUT}`)
}

function compare() {
  const before = JSON.parse(readFileSync('prod-before.json', 'utf8')) as Record<string, { status: number; body: string }>
  const after = JSON.parse(readFileSync('prod-after.json', 'utf8')) as Record<string, { status: number; body: string }>
  let failures = 0
  const check = (label: string, pass: boolean, detail = '') => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
    if (!pass) failures++
  }

  console.log(`before: ${before.__version.body}`)
  console.log(`after:  ${after.__version.body}\n`)
  check('the deployed SHA actually changed', before.__version.body !== after.__version.body)

  console.log('\n--- MULTI-RESTAURANT: the reported defect ---')
  const histKey = Object.keys(before).find((k) => k.startsWith('multi /api/orders/history'))!
  check(
    'BEFORE: production refused Order History',
    before[histKey].status === 409,
    `HTTP ${before[histKey].status}`,
  )
  check(
    'AFTER: production answers Order History',
    after[histKey].status === 200,
    `HTTP ${after[histKey].status}`,
  )
  check(
    'AFTER: no "restaurantId" in an error payload',
    !(after[histKey].body.includes('"error"') && after[histKey].body.includes('restaurantId')),
  )

  console.log('\n--- SINGLE-RESTAURANT CONTROL: every ChowNow staff member ---')
  for (const key of Object.keys(before).filter((k) => k.startsWith('single '))) {
    const same = before[key].status === after[key].status && before[key].body === after[key].body
    check(key.replace('single ', ''), same,
      same ? `HTTP ${after[key].status} identical` : `${before[key].status} -> ${after[key].status}, body ${before[key].body === after[key].body ? 'same' : 'CHANGED'}`)
    if (!same) {
      console.log(`      before: ${before[key].body.slice(0, 200)}`)
      console.log(`      after:  ${after[key].body.slice(0, 200)}`)
    }
  }

  console.log(`\n${failures === 0 ? 'PRODUCTION VERIFIED -- defect fixed, single-restaurant unchanged' : `${failures} CHECK(S) FAILED -- ROLL BACK`}`)
  process.exit(failures === 0 ? 0 : 1)
}

if (MODE === 'compare') {
  if (!existsSync('prod-before.json') || !existsSync('prod-after.json')) {
    throw new Error('need both prod-before.json and prod-after.json')
  }
  compare()
} else {
  capture().catch((e) => {
    console.error('CAPTURE FAILED:', e.message)
    process.exit(1)
  })
}
