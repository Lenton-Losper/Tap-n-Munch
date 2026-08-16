/**
 * #196 -- the one open question: does the guest API ever hand the client a NON-STRING order id?
 *
 * `ActiveOrderBanner` did `setLastOrder({ id: String(data.id), ...data })`, where the spread
 * overwrites the conversion. #196 argues that is type-only because `orders.id` is a uuid and
 * arrives as a JSON string, so `String(data.id) === data.id` on every path -- but it records that
 * a LIVE RESPONSE BODY WAS NEVER OBSERVED. Column type, migration and TS type are three
 * declarations; none of them is the wire.
 *
 * So this reads the wire. It checks the RAW TEXT, not the parsed object: `JSON.parse` turns
 * `"id": 7` and `"id": "7"` into distinguishable values, but only the raw bytes show whether the
 * server quoted it, and quoting is the actual question.
 *
 * Read-only. It selects existing orders and issues GETs. It writes nothing.
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const BASE = process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: not the staging project: ${url}`)
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

/**
 * Calibrate the detector before trusting it (#169's rule, applied here). A detector that has only
 * ever been pointed at quoted ids has not been tested -- it has been confirmed.
 */
function detectQuoted(text: string): boolean {
  const m = text.match(/"id"\s*:\s*(.)/)
  if (!m) throw new Error(`no "id" field in: ${text.slice(0, 80)}`)
  return m[1] === '"'
}

function calibrate() {
  const quoted = '{"orders":[{"id":"7f3c-uuid","total":10}]}'
  const unquoted = '{"orders":[{"id":7,"total":10}]}'
  if (detectQuoted(quoted) !== true) throw new Error('CONTROL FAILED: quoted id read as unquoted')
  if (detectQuoted(unquoted) !== false) throw new Error('CONTROL FAILED: unquoted id read as quoted')
  console.log('controls: quoted -> string, unquoted -> NON-string. Detector can tell them apart.')
}

async function main() {
  calibrate()
  const { data: rows, error } = await admin
    .from('orders')
    .select('id, restaurant_id, table_number, session_id, member_session_id')
    .order('placed_at', { ascending: false })
    .limit(25)
  if (error) throw error
  if (!rows?.length) {
    console.log('INCONCLUSIVE-AS-FAIL: no orders on staging, so nothing was observed.')
    process.exit(1)
  }

  console.log(`sampling ${rows.length} most recent staging orders`)
  console.log('')

  let observed = 0
  let nonString = 0

  for (const row of rows) {
    const params = new URLSearchParams({ restaurantId: String(row.restaurant_id) })
    if (row.table_number != null) params.set('table_number', String(row.table_number))
    for (const s of [row.session_id, row.member_session_id]) {
      if (s) params.append('session_id', String(s))
    }
    const res = await fetch(`${BASE}/api/guest/orders/${row.id}?${params.toString()}`)
    const text = await res.text()
    if (res.status !== 200) continue

    // The decisive bytes. A quoted id looks like  "id":"7f3c..."  ; an unquoted one like  "id":7
    if (!/"id"/.test(text)) continue
    observed++
    const quoted = detectQuoted(text)
    if (!quoted) {
      nonString++
      console.log(`NON-STRING id on the wire for ${row.id}: ${text.slice(0, 120)}`)
    }
    const parsed = JSON.parse(text)
    const typeofId = typeof parsed?.orders?.[0]?.id
    if (typeofId !== 'string') {
      nonString++
      console.log(`typeof parsed id = ${typeofId} for ${row.id}`)
    }
  }

  console.log(`observed ${observed} live 200 responses`)
  console.log(`non-string ids: ${nonString}`)
  console.log('')

  if (observed === 0) {
    // The vacuous case, reported as a failure rather than as silence -- every row could have been
    // 404 (denied) and "0 non-string ids" would then prove exactly nothing.
    console.log('INCONCLUSIVE-AS-FAIL: 0 responses were readable, so 0 non-string ids proves nothing.')
    process.exit(1)
  }
  console.log(
    nonString === 0
      ? `SETTLED: every one of ${observed} live guest-order responses carried a QUOTED string id.`
      : 'FOUND: the guest API does hand out a non-string id. #196 item 1 was live.'
  )
  console.log('PROBE_196_DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
