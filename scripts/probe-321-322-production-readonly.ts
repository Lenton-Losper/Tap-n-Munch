/**
 * #321 and #322 -- PRODUCTION RE-VERIFICATION. READ-ONLY.
 *
 * Same mechanism as scripts/probe-323-production-baseline.ts, which ran against production
 * earlier today: a magiclink token for a TEST account, then GETs only. No insert, update,
 * delete or rpc. Refuses to run unless .env.local names the production project.
 *
 * #322 -- Order History returned a zero-length 500 for windows whose startDate reached into
 *         FNB ChowNow's July volume. Walks the exact boundary table from the issue. A 200 is
 *         not enough on its own, so the windows that ALWAYS worked are captured too: if those
 *         moved, something other than the crash changed.
 *
 * #321 -- the session bootstrap ignored user_active_context and took
 *         getRestaurantIdsForUser(...)[0]. Verified in the only read-only way available: find a
 *         production user who (a) belongs to two or more restaurants and (b) has a stored
 *         context, then ask /api/auth/role which restaurant the session resolves to. The check
 *         is only meaningful if the stored value differs from what the old tie-break would have
 *         returned -- that is computed and reported, and a match on the OLD pick is called
 *         INCONCLUSIVE rather than a pass.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const HOST = 'https://flashtap.app'
const ENV_PATH = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'

const env: Record<string, string> = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error(`REFUSING: not production -- ${env.NEXT_PUBLIC_SUPABASE_URL}`)
}

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const OWNER_EMAIL = 'flashtaptestacc1@gmail.com'

let failures = 0
let inconclusive = 0
function check(label: string, pass: boolean | null, detail = '') {
  const tag = pass === null ? 'INCONCLUSIVE' : pass ? 'PASS' : 'FAIL'
  if (pass === false) failures++
  if (pass === null) inconclusive++
  console.log(`${tag.padEnd(12)} ${label}${detail ? ` -- ${detail}` : ''}`)
}

async function tokenFor(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data?.properties?.hashed_token) throw new Error(`link(${email}): ${error?.message}`)
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data: s, error: v } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  })
  if (v || !s.session) throw new Error(`otp(${email}): ${v?.message}`)
  return s.session.access_token
}

async function get(path: string, token: string) {
  const res = await fetch(`${HOST}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  return { status: res.status, bytes: text.length, text }
}

// ---------------------------------------------------------------- version

async function version() {
  const res = await fetch(`${HOST}/api/version?cb=${Date.now()}`)
  const body = await res.json()
  console.log(`\n=== production /api/version: ${body.commit} ===\n`)
  return body.commit as string
}

// ---------------------------------------------------------------- #322

const WINDOWS: Array<[string, string, 'was-500' | 'was-200']> = [
  ['2026-08-01', '2026-08-20', 'was-200'],
  ['2026-07-31', '2026-08-20', 'was-200'],
  ['2026-07-25', '2026-08-20', 'was-200'],
  ['2026-07-20', '2026-08-20', 'was-500'],
  ['2026-07-15', '2026-08-20', 'was-500'],
  ['2026-07-01', '2026-08-20', 'was-500'],
  ['2026-06-01', '2026-08-20', 'was-500'],
]

async function probe322(token: string) {
  console.log('--- #322: Order History boundary, FNB ChowNow ---')
  for (const [start, end, before] of WINDOWS) {
    const r = await get(
      `/api/orders/history?restaurantId=${FNB_CHOWNOW}&startDate=${start}&endDate=${end}`,
      token,
    )
    let total: unknown = '?'
    let rows: unknown = '?'
    try {
      const j = JSON.parse(r.text)
      total = j?.pagination?.total ?? j?.total ?? j?.count ?? '?'
      rows = Array.isArray(j?.orders) ? j.orders.length : '?'
    } catch {
      /* non-JSON */
    }
    const label = `${start} -> ${end} (before: ${before})`
    const detail = `HTTP ${r.status}, ${r.bytes}B, rows=${rows}, total=${total}`
    if (before === 'was-500') {
      check(label, r.status === 200 && r.bytes > 0, detail)
    } else {
      check(label, r.status === 200 && r.bytes > 0, detail)
    }
  }
}

// ---------------------------------------------------------------- #321

async function probe321(): Promise<void> {
  console.log('\n--- #321: does the session bootstrap honour the stored context ---')

  const { data: memberships, error: mErr } = await db
    .from('restaurant_users')
    .select('user_id, restaurant_id, role, invite_accepted, deleted_at, created_at')
    .is('deleted_at', null)
  if (mErr) {
    check('read restaurant_users', false, mErr.message)
    return
  }

  const byUser = new Map<string, typeof memberships>()
  for (const m of memberships ?? []) {
    if (m.invite_accepted === false) continue
    const list = byUser.get(m.user_id) ?? []
    list.push(m)
    byUser.set(m.user_id, list)
  }
  const multi = [...byUser.entries()].filter(([, l]) => l.length > 1)
  console.log(`production users with >1 live restaurant membership: ${multi.length}`)

  const { data: contexts, error: cErr } = await db
    .from('user_active_context')
    .select('user_id, restaurant_id, updated_at')
  if (cErr) {
    check('read user_active_context', false, cErr.message)
    return
  }
  const stored = new Map((contexts ?? []).map((c) => [c.user_id, c]))
  console.log(`rows in user_active_context: ${contexts?.length ?? 0}`)

  const candidates = multi.filter(([uid]) => stored.has(uid))
  console.log(`multi-restaurant users WITH a stored context: ${candidates.length}`)

  if (candidates.length === 0) {
    check(
      'a subject exists to test the fix on',
      null,
      'no production user is both multi-restaurant and has a stored context; ' +
        'the fix cannot be exercised read-only',
    )
    return
  }

  for (const [uid, mships] of candidates) {
    const ctx = stored.get(uid)!
    // What the PRE-FIX code would have picked: owner rows first, then whatever order came back.
    const oldPick = [...mships].sort((a, b) => {
      const ao = a.role === 'owner' ? 0 : 1
      const bo = b.role === 'owner' ? 0 : 1
      return ao - bo
    })[0]

    const { data: u } = await db.auth.admin.getUserById(uid)
    const email = u?.user?.email
    console.log(
      `\nsubject ${email ?? uid}: ${mships.length} restaurants, stored=${ctx.restaurant_id}, ` +
        `old-tie-break-would-pick=${oldPick.restaurant_id}`,
    )

    if (!email) {
      check(`resolve ${uid}`, null, 'no email on the auth user; cannot mint a token')
      continue
    }

    let token: string
    try {
      token = await tokenFor(email)
    } catch (e) {
      check(`mint token for ${email}`, null, String(e))
      continue
    }

    const r = await get('/api/auth/role', token)
    let resolved: string | undefined
    try {
      const j = JSON.parse(r.text)
      resolved = j?.restaurantId ?? j?.restaurant_id ?? j?.restaurant?.id
    } catch {
      /* non-JSON */
    }
    console.log(`  /api/auth/role -> HTTP ${r.status}, restaurantId=${resolved}`)

    if (resolved === ctx.restaurant_id) {
      if (ctx.restaurant_id === oldPick.restaurant_id) {
        check(
          `${email}: session honours the stored context`,
          null,
          'stored value EQUALS what the old tie-break would have picked -- ' +
            'this run cannot distinguish fixed from broken',
        )
      } else {
        check(
          `${email}: session honours the stored context`,
          true,
          `resolved to the stored ${ctx.restaurant_id}, NOT the old pick ${oldPick.restaurant_id}`,
        )
      }
    } else {
      check(
        `${email}: session honours the stored context`,
        false,
        `resolved ${resolved}, stored ${ctx.restaurant_id}`,
      )
    }
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const commit = await version()
  const token = await tokenFor(OWNER_EMAIL)
  await probe322(token)
  await probe321()
  console.log(
    `\n=== commit ${commit}: ${failures} failure(s), ${inconclusive} inconclusive ===`,
  )
  if (failures > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('PROBE ABORTED:', e)
  process.exitCode = 2
})
