/**
 * PRE-LAUNCH GATE — no venue takes its first card until its Finatic credentials are set.
 * STRICTLY READ-ONLY. One GET against `restaurants`.
 *
 * WHY THIS EXISTS. On 2026-08-21, FNB ChowNow order #851 settled only because the
 * `fallback_verified_paid` path queried Finatic directly after the webhook signature failed
 * ("Encryption block is invalid." — #107). Every card taken that day settled the same way; not one
 * went through the signed webhook. So the fallback is the primary settlement path, and it opens
 * with:
 *
 *     const creds = await getRestaurantFinaticCredentials(restaurantId)   // throws if unconfigured
 *
 * A venue with NULL finatic_merchant_no / finatic_store_no therefore has NO settlement path at all:
 * the card clears at the gateway, the signature check fails, the fallback throws, and the order is
 * never marked paid. The money is gone and FlashTap shows unpaid.
 *
 * Chownow Nedbank was in exactly that state on the day its devices were handed over. It had not
 * traded yet, so nothing was lost — this gate is what makes that luck rather than a near miss.
 *
 * Usage:
 *   node scripts/check-venue-payment-readiness.mjs                 # every venue with a terminal
 *   node scripts/check-venue-payment-readiness.mjs <restaurantId>  # one venue
 *   node scripts/check-venue-payment-readiness.mjs --all           # every venue, test rows included
 *
 * Exit 0 = every venue checked is ready. Exit 1 = at least one is not.
 */
import { readFileSync } from 'node:fs'

const ENV_PATH = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'

const env = {}
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !URL_.includes(PROD_REF)) throw new Error(`REFUSING: not production — ${URL_}`)
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const arg = process.argv[2]
const wantAll = arg === '--all'
const onlyId = arg && !wantAll ? arg : null

async function get(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: H })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

const venues = await get(
  'restaurants?select=id,name,finatic_merchant_no,finatic_store_no,checkout_merchant_no,checkout_store_no&order=created_at.asc',
)
// A venue with a registered terminal is one that can take a card, which is what this gate is about.
const terminals = await get('restaurant_terminals?select=restaurant_id,status,active')
const withTerminal = new Set(
  terminals.filter((t) => t.active === true || t.status === 'active').map((t) => String(t.restaurant_id)),
)

let failures = 0
let checked = 0
console.log('PRE-LAUNCH PAYMENT READINESS — production\n')

for (const v of venues) {
  const hasTerminal = withTerminal.has(String(v.id))
  if (onlyId && v.id !== onlyId) continue
  if (!onlyId && !wantAll && !hasTerminal) continue
  checked++

  const card = Boolean(String(v.finatic_merchant_no || '').trim() && String(v.finatic_store_no || '').trim())
  const checkout = Boolean(
    String(v.checkout_merchant_no || '').trim() && String(v.checkout_store_no || '').trim(),
  )

  if (!card) failures++
  const verdict = card ? 'READY' : 'BLOCKED'
  console.log(`${verdict.padEnd(8)} ${v.name}`)
  console.log(`         id           ${v.id}`)
  console.log(`         terminal     ${hasTerminal ? 'registered' : 'none registered'}`)
  console.log(
    `         card pair    ${card ? `${v.finatic_merchant_no} / ${v.finatic_store_no}` : 'MISSING — this venue cannot settle a card'}`,
  )
  console.log(
    `         checkout     ${checkout ? `${v.checkout_merchant_no} / ${v.checkout_store_no}` : 'not set — QR / hosted checkout would send a blank merchant number'}`,
  )
  console.log()
}

console.log(`checked ${checked} venue(s); ${failures} BLOCKED\n`)

if (failures) {
  console.log('A BLOCKED venue must not take a card. Required from Finatic, per venue:')
  console.log('  finatic_merchant_no  — 12 digits, live venues all begin 3426')
  console.log('  finatic_store_no     — 10 digits, live venues all begin 4426')
  console.log('  checkout_merchant_no / checkout_store_no — only if the venue takes QR payments.')
  console.log("  Ask rather than assume: Riviera's checkout merchant differs from its card one.")
  console.log('\nThe app-level app_id and keys are environment-wide and are NOT per venue — unless')
  console.log('the venue is onboarded under a different Finatic account, which is worth asking.')
  process.exitCode = 1
}

// NOTE ON WHAT THIS DOES NOT CHECK. It reads columns; it does not call Finatic. A merchant/store
// pair that is present but wrong passes here and fails at the till. Confirming the pair is live
// means running one real card at the venue and watching the order settle — which is the actual
// first-card test this gate exists to protect, not replace.
