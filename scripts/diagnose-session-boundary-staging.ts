/**
 * CAN THE MY-ORDERS READ BE SCOPED TO A STILL-VALID SESSION WITHOUT HIDING LEGITIMATE ORDERS?
 *
 * THE DEFECT, measured 2026-08-18. `close_table_session` expires the `customer_sessions` rows and
 * bumps `restaurant_tables.current_session_version`. `validateSessionToken` enforces that boundary
 * correctly — "Session version mismatch — table has been reset". But
 * `app/api/guest/orders/by-session` never calls it: it scopes by `restaurant_id` + `session_id`
 * and nothing else. And the phone's `flashtap_session_v1` survives the close, because the only
 * thing that would clear it (`useSessionTokenGuard`) is imported by NO screen.
 *
 * So a customer at a cleared table keeps the same session id and sees their own pre-close orders.
 *
 * THE CANDIDATE FIX is to scope the read to sessions that are still valid — join `customer_sessions`
 * and require not-expired AND session_version === the table's current. THE RISK is the #302 shape
 * in reverse: if orders exist whose `session_id` has NO `customer_sessions` row, that filter hides
 * legitimate orders from the customer who placed them, which is worse than the defect.
 *
 * THIS PROBE ANSWERS THAT, and nothing else:
 *   - how many orders / requests have a session_id with no customer_sessions row at all
 *   - how many have one whose session_version is behind the table's current
 *   - the same split for rows placed in the last 24h, which is the population that matters
 *
 * STRICTLY READ-ONLY. Selects only. Staging.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url} is not the staging project`)
const admin = createClient(url, key, { auth: { persistSession: false } })

const DAY = 24 * 60 * 60 * 1000

async function analyse(table: string) {
  const { data: rows, error } = await admin
    .from(table)
    .select('id, session_id, table_id, placed_at')
    .not('session_id', 'is', null)
    .order('placed_at', { ascending: false })
    .limit(1000)
  if (error) {
    console.log(`  ${table}: READ FAILED ${error.message}`)
    return
  }
  const list = rows ?? []
  if (list.length === 0) {
    console.log(`  ${table}: no rows — nothing below is meaningful`)
    return
  }

  const sessionIds = [...new Set(list.map((r) => String(r.session_id)))]
  const sessions = new Map()
  for (let i = 0; i < sessionIds.length; i += 200) {
    const { data } = await admin
      .from('customer_sessions')
      .select('session_id, session_version, expires_at, table_id')
      .in('session_id', sessionIds.slice(i, i + 200))
    for (const s of data ?? []) sessions.set(String(s.session_id), s)
  }

  const tableIds = [...new Set(list.map((r) => String(r.table_id)).filter(Boolean))]
  const tableVersion = new Map()
  for (let i = 0; i < tableIds.length; i += 200) {
    const { data } = await admin
      .from('restaurant_tables')
      .select('id, current_session_version')
      .in('id', tableIds.slice(i, i + 200))
    for (const t of data ?? []) tableVersion.set(String(t.id), t.current_session_version)
  }

  const now = Date.now()
  let noSession = 0
  let expired = 0
  let behindVersion = 0
  let clean = 0
  let recentNoSession = 0
  let recent = 0

  for (const r of list) {
    const isRecent = now - Date.parse(String(r.placed_at ?? '')) < DAY
    if (isRecent) recent += 1
    const s = sessions.get(String(r.session_id))
    if (!s) {
      noSession += 1
      if (isRecent) recentNoSession += 1
      continue
    }
    const exp = Date.parse(String(s.expires_at ?? ''))
    const current = tableVersion.get(String(r.table_id))
    if (Number.isFinite(exp) && exp < now) expired += 1
    else if (current != null && s.session_version !== current) behindVersion += 1
    else clean += 1
  }

  console.log(`\n  ${table}  (n=${list.length}, ${recent} placed in the last 24h)`)
  console.log(`    session_id has NO customer_sessions row : ${noSession}   (${recentNoSession} of them recent)`)
  console.log(`    session row EXPIRED                     : ${expired}`)
  console.log(`    session row BEHIND the table's version  : ${behindVersion}`)
  console.log(`    still valid                             : ${clean}`)
}

async function main() {
  console.log('\nSTAGING — would a validity filter hide legitimate orders?\n')
  const { data: control } = await admin.from('customer_sessions').select('session_id').limit(1)
  console.log(`  [control] customer_sessions is readable and non-empty : ${control?.length ? 'YES' : 'NO — nothing below is meaningful'}`)

  await analyse('orders')
  await analyse('order_requests')

  console.log(
    '\n  READ IT THIS WAY: a large "NO customer_sessions row" count means a validity filter\n' +
      '  would hide orders from the customer who placed them — the #302 shape in reverse — and the\n' +
      '  fix has to be a token requirement or a version stamped on the order instead.',
  )
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
