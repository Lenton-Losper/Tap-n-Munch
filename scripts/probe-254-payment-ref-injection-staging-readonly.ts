/**
 * #254 — re-measure the `?ref=` PostgREST `.or()` injection on STAGING. READ-ONLY.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT.
 * This exercises the DATABASE through THIS BRANCH's `paymentRefOrFilter`, not through the
 * deployed staging Worker. Nothing is deployed by this branch, so a clean result here means
 * "the code in this working tree closes the hole against the real staging data". It does NOT
 * mean the deployed staging Worker is fixed — that Worker still runs `c2c5d84`, which carries
 * the injectable form. Do not read the numbers below as a statement about the deployed surface.
 *
 * Method — the exact pair from the 2026-08-11 measurement, run twice:
 *   BEFORE  the injectable expression as it stands at origin/cloudflare-staging, inlined here
 *           as a literal control so both sides are measured in one run against the same rows.
 *   AFTER   this branch's validated `paymentRefOrFilter`.
 *
 * Every statement issued is a SELECT. There is no insert/update/delete/upsert/rpc in this file,
 * and that is checkable mechanically:
 *
 *     grep -nE "\.(insert|update|delete|upsert|rpc)\(" <this file>     -> zero hits
 *
 * The unscoped `.or()` (no restaurant_id) is deliberate: it is what the original measurement did,
 * and it is what shows the widening. On this branch doors 2 and 3 would additionally bound the
 * route — measuring through them would hide the thing being measured.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { paymentRefOrFilter } from '../lib/guest-orders/validation'

// ---------------------------------------------------------------------------
// GUARD. Runs BEFORE any client is constructed. Production must be unreachable
// from this file even by accident, and only staging is permitted.
// ---------------------------------------------------------------------------
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF_ALLOWLIST = ['mdqjpxwczrhkxkbqatqa']

config({ path: resolve(__dirname, '..', '.env.test'), override: true })

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

if (!url) throw new Error('GUARD: no Supabase URL resolved from .env.test')
if (url.includes(PRODUCTION_REF)) {
  throw new Error(`GUARD: resolved URL points at PRODUCTION (${PRODUCTION_REF}). Refusing to run.`)
}
const projectRef = new URL(url).hostname.split('.')[0]
if (!STAGING_REF_ALLOWLIST.includes(projectRef)) {
  throw new Error(`GUARD: project ref ${projectRef} is not on the staging allowlist. Refusing.`)
}
if (!serviceKey) throw new Error('GUARD: no service role key resolved from .env.test')

console.log(`GUARD PASSED — project ref ${projectRef} (staging), production ref rejected.`)

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** The exact expression at origin/cloudflare-staging:lib/guest-orders/validation.ts:52. */
function injectablePaymentRefOrFilter(ref: string): string {
  const trimmed = ref.trim()
  return `paycloud_merchant_order_no.eq.${trimmed},payment_reference.eq.${trimmed}`
}

const BENIGN = 'NONEXISTENT-REF-ZZZZZZ'
const INJECTED = 'NONEXISTENT-REF-ZZZZZZ,id.not.is.null'

type Result = { rows: number; restaurants: number; filter: string | null }

async function measure(filter: string | null): Promise<Result> {
  if (filter === null) return { rows: 0, restaurants: 0, filter: null }
  const { data, error } = await supabase.from('orders').select('id,restaurant_id').or(filter)
  if (error) throw error
  const rows = data ?? []
  return {
    rows: rows.length,
    restaurants: new Set(rows.map((r) => String(r.restaurant_id))).size,
    filter,
  }
}

function report(label: string, ref: string, r: Result) {
  console.log(
    `${label.padEnd(30)} ref=${JSON.stringify(ref).padEnd(42)} ` +
      `-> ${String(r.rows).padStart(4)} rows / ${r.restaurants} restaurants  ` +
      `filter=${r.filter === null ? 'NULL (no query issued)' : JSON.stringify(r.filter)}`,
  )
}

async function main() {
  console.log('\n--- BEFORE: origin/cloudflare-staging expression (control) ---')
  report('BEFORE benign', BENIGN, await measure(injectablePaymentRefOrFilter(BENIGN)))
  report('BEFORE injected', INJECTED, await measure(injectablePaymentRefOrFilter(INJECTED)))

  console.log('\n--- AFTER: this branch\'s validated paymentRefOrFilter ---')
  report('AFTER benign', BENIGN, await measure(paymentRefOrFilter(BENIGN)))
  report('AFTER injected', INJECTED, await measure(paymentRefOrFilter(INJECTED)))

  console.log(
    '\nCEILING: this exercised the DATABASE via local code. The deployed staging Worker is ' +
      'unchanged and still runs the BEFORE expression.',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
