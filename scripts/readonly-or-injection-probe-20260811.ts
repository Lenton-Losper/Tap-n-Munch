/**
 * READ ONLY. Two-sided proof that lib/payments/resolve-order-by-merchant-order.ts:20 is
 * filter-injectable, and that the sanitiser the repo already has would have refused it.
 *
 * Every call is a .select() with { head: true, count: 'exact' } -- rows are never fetched, only
 * counted, so nothing about anyone's orders is read into this process. No writes anywhere.
 *
 * STAGING ONLY, allowlisted before the client is constructed.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { isWellFormedPaymentRef, paymentRefOrFilter } from '../lib/guest-orders/validation'

const WORKTREE = 'C:/Users/223125318/Desktop/mvp/sp-qr-state'
config({ path: `${WORKTREE}/.env.test`, override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = String(process.env.SUPABASE_URL || '').trim()
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || ''

if (!ref) throw new Error(`Could not parse a project ref from SUPABASE_URL (${url || 'unset'})`)
if (ref === PRODUCTION_REF) throw new Error(`REFUSING: SUPABASE_URL points at PRODUCTION (${ref})`)
if (ref !== STAGING_REF) throw new Error(`REFUSING: ref ${ref} is not the allowlisted staging ref ${STAGING_REF}`)
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is unset')

console.log(`[guard] ok — staging ref ${ref} (READ ONLY, counts only)`)

const supabase = createClient(url, key, { auth: { persistSession: false } })

/** The vulnerable expression, verbatim from resolve-order-by-merchant-order.ts:20. */
function vulnerableFilter(mo: string): string {
  return `paycloud_merchant_order_no.eq.${mo},payment_reference.eq.${mo}`
}

async function countMatching(filter: string): Promise<number | string> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .or(filter)
  if (error) return `ERROR: ${error.message}`
  return count ?? 0
}

async function main() {
  const { count: totalOrders } = await supabase.from('orders').select('id', { count: 'exact', head: true })
  console.log(`\norders on staging: ${totalOrders}`)

  // A reference that exists nowhere. This is the control: the benign case must match nothing.
  const BENIGN = 'NONEXISTENT-REF-ZZZZZZ'
  // The same reference with one PostgREST predicate appended. Nothing else changes.
  const INJECTED = 'NONEXISTENT-REF-ZZZZZZ,id.not.is.null'

  console.log(`\n=== SIDE 1: benign reference (control) ===`)
  console.log(`  mo       = ${JSON.stringify(BENIGN)}`)
  console.log(`  filter   = ${vulnerableFilter(BENIGN)}`)
  console.log(`  MATCHED  = ${await countMatching(vulnerableFilter(BENIGN))}`)

  console.log(`\n=== SIDE 2: same reference + one injected predicate ===`)
  console.log(`  mo       = ${JSON.stringify(INJECTED)}`)
  console.log(`  filter   = ${vulnerableFilter(INJECTED)}`)
  console.log(`  MATCHED  = ${await countMatching(vulnerableFilter(INJECTED))}`)

  // Does the widening cross restaurants? Count distinct restaurants in the widened set.
  const { data: widened, error: widenErr } = await supabase
    .from('orders')
    .select('restaurant_id')
    .or(vulnerableFilter(INJECTED))
  if (!widenErr) {
    const restaurants = new Set((widened ?? []).map((r) => String(r.restaurant_id)))
    console.log(`  distinct restaurants in the widened set: ${restaurants.size}  <-- the .or() carries no restaurant scope`)
  }

  console.log(`\n=== THE SANITISER THE REPO ALREADY HAS ===`)
  for (const candidate of [BENIGN, INJECTED]) {
    console.log(
      `  isWellFormedPaymentRef(${JSON.stringify(candidate)}) = ${isWellFormedPaymentRef(candidate)}` +
        `  ->  paymentRefOrFilter = ${JSON.stringify(paymentRefOrFilter(candidate))}`,
    )
  }
  console.log(`  (a null filter is the caller's signal to match nothing -- fail closed)`)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
