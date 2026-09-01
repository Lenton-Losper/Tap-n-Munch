/**
 * CARD PAYMENT READINESS — is every precondition for a real card tap in place, per venue?
 *
 * ============================================================================================
 * WHAT THIS DOES AND DOES NOT DO
 * ============================================================================================
 *
 * It initiates NOTHING. No payment, no charge, no order, no write of any kind. Every check is a
 * read, and the one network call it makes is a GET against the deployed webhook route to prove
 * the endpoint exists. It deliberately does NOT POST to the webhook: that route marks orders paid,
 * and probing a live settlement endpoint to see what it does is not a test, it is a transaction.
 *
 * The point is to reduce "can this venue take a card?" to exactly one unknown — whether the
 * physical card is accepted at the terminal — by proving every other precondition mechanically.
 *
 * ============================================================================================
 * WHY CREDENTIALS ARE THE FIRST AND HARDEST GATE
 * ============================================================================================
 *
 * `getRestaurantFinaticCredentials` throws MissingFinaticCredentialsError when merchantNo or
 * storeNo is blank, and every card path is downstream of it. There is no fallback: no credentials
 * means no card, ever, for that venue. That is exactly how ChowNow Nedbank failed a live NAD 17
 * card payment on 2026-09-01.
 *
 * Credentials are read here STRAIGHT FROM THE DATABASE, which is deliberately NOT how the app
 * reads them — the app goes through a Redis cache (lib/cache/restaurant-cache.ts). The two can
 * disagree, and have: after the same incident, saving credentials left a stale empty entry in
 * Redis so the card kept failing with the row correctly populated. So this script reports the
 * DATABASE truth and says plainly that the cache is a second, separate question. Checking the
 * cache requires the app's own runtime; see the note printed at the end.
 *
 * Usage:  node scripts/prod/verify-card-payment-readiness.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const ENV_PATH = 'C:/Users/223125318/Desktop/mvp2/Tap-n-Munch/.env.local'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const WEBHOOK_URL = 'https://www.flashtap.app/api/webhooks/paycloud'
/** A terminal not seen for this long cannot be assumed to be on the counter. */
const SEEN_RECENTLY_DAYS = 7

const env = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
if (!String(env.NEXT_PUBLIC_SUPABASE_URL || '').includes(PRODUCTION_REF)) {
  throw new Error('refusing to run: this is not the production project')
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const PASS = 'PASS'
const FAIL = 'FAIL'
const WARN = 'WARN'

async function pageAll(table, cols) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < 1000) return out
  }
}

// ── 1. venue credentials ─────────────────────────────────────────────────────

const restaurants = await pageAll(
  'restaurants',
  'id, name, finatic_merchant_no, finatic_store_no, finatic_terminal_sn, checkout_merchant_no, checkout_store_no',
)
if (restaurants.length === 0) {
  throw new Error('read 0 restaurants — the probe itself is broken, not the venues')
}

const terminals = await pageAll(
  'restaurant_terminals',
  'id, restaurant_id, terminal_name, status, app_version, last_seen_at, station_kind',
)

const cutoff = Date.now() - SEEN_RECENTLY_DAYS * 86_400_000

console.log('CARD PAYMENT READINESS — production, read-only, no charge initiated')
console.log(`Checked ${restaurants.length} venues and ${terminals.length} terminals.\n`)

const rows = []
for (const r of restaurants) {
  const merchantNo = String(r.finatic_merchant_no || '').trim()
  const storeNo = String(r.finatic_store_no || '').trim()
  // The exact condition getRestaurantFinaticCredentials throws on.
  const credsOk = Boolean(merchantNo && storeNo)

  const mine = terminals.filter((t) => t.restaurant_id === r.id)
  // A station screen is a wall display, not a card reader.
  const tills = mine.filter((t) => t.status === 'active' && t.station_kind == null)
  const live = tills.filter((t) => t.last_seen_at && Date.parse(t.last_seen_at) > cutoff)

  rows.push({
    name: r.name,
    creds: credsOk ? PASS : FAIL,
    merchantNo: merchantNo ? `${merchantNo.slice(0, 4)}…` : '—',
    storeNo: storeNo ? `${storeNo.slice(0, 4)}…` : '—',
    tills: tills.length,
    live: live.length,
    versions: [...new Set(live.map((t) => t.app_version || '?'))].join(','),
    verdict: !credsOk ? FAIL : live.length === 0 ? WARN : PASS,
  })
}

rows.sort((a, b) => (a.verdict === b.verdict ? a.name.localeCompare(b.name) : a.verdict === FAIL ? -1 : 1))

console.log('  VENUE                      CREDS  MERCHANT  STORE   TILLS  LIVE  VERSIONS   VERDICT')
console.log('  ' + '-'.repeat(84))
for (const x of rows) {
  console.log(
    `  ${x.name.slice(0, 24).padEnd(26)}${x.creds.padEnd(7)}${x.merchantNo.padEnd(10)}${x.storeNo.padEnd(8)}` +
      `${String(x.tills).padEnd(7)}${String(x.live).padEnd(6)}${x.versions.slice(0, 10).padEnd(11)}${x.verdict}`,
  )
}

console.log('\n  FAIL   = no credentials. Every card path throws MissingFinaticCredentialsError.')
console.log(`  WARN   = credentials fine, but no till has checked in within ${SEEN_RECENTLY_DAYS} days.`)
console.log('  PASS   = credentials present and a till is live. Ready for a physical card.')

// ── 2. the settlement endpoint ───────────────────────────────────────────────

console.log('\nSETTLEMENT ENDPOINT')
try {
  const res = await fetch(`${WEBHOOK_URL}?readiness=${Date.now()}`, { method: 'GET' })
  const body = await res.text()
  console.log(`  GET ${WEBHOOK_URL}`)
  console.log(`    HTTP ${res.status} — ${res.status < 500 ? PASS : FAIL} (deployed and answering)`)
  console.log(`    body: ${body.slice(0, 160).replace(/\s+/g, ' ')}`)
  console.log('    NOT POSTed on purpose: this route marks orders paid.')
} catch (err) {
  console.log(`  GET ${WEBHOOK_URL} -> ${FAIL} ${err.message}`)
}

// ── 3. what the ledger says about card payments so far ───────────────────────

console.log('\nEVIDENCE THAT THE PATH HAS EVER WORKED')
const events = await pageAll('payment_events', 'id, restaurant_id, event_type, amount, created_at')
const byVenue = {}
for (const e of events) {
  if (e.event_type !== 'sale') continue
  const k = restaurants.find((r) => r.id === e.restaurant_id)?.name ?? '?'
  const v = (byVenue[k] ??= { n: 0, last: null })
  v.n++
  if (!v.last || e.created_at > v.last) v.last = e.created_at
}
for (const [name, v] of Object.entries(byVenue).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${name.padEnd(26)} ${String(v.n).padStart(4)} sale events   last: ${v.last}`)
}
const noSales = rows.filter((r) => r.verdict === PASS && !byVenue[r.name])
if (noSales.length) {
  console.log(`\n  Ready but no sale event has EVER been recorded: ${noSales.map((r) => r.name).join(', ')}`)
  console.log('  These are the venues where a first physical tap is genuinely unproven.')
}

console.log('\nSTILL UNVERIFIABLE WITHOUT A PHYSICAL CARD')
console.log('  - that the reader accepts a card and returns a success result code')
console.log('  - that Finatic posts the webhook back to this deployment for a real transaction')
console.log('  - the credential CACHE (Redis) agreeing with the rows above; that needs the app runtime')
