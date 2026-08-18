/**
 * HOW MANY PRODUCTION ORDERS SAY "cash", AND HOW MANY OF THOSE WERE NEVER ASKED?
 *
 * Strictly read-only. Selects only — no insert, update, delete or rpc. Refuses to run unless
 * SUPABASE_URL is the production project.
 *
 * ============================================================================================
 * THE QUESTION THIS ANSWERS, AND THE ONE IT CANNOT
 * ============================================================================================
 *
 * It answers: how many rows hold 'cash', and how many of those are TAB orders — the path where
 * `app/api/orders/route.ts` never asked, because `paymentMethodIsChosenAtSubmission = !isTabOrder`
 * skips the accepted-methods validation for exactly that reason.
 *
 * IT CANNOT ANSWER whether a given 'cash' came from the COLUMN DEFAULT or from an explicit write.
 * Postgres keeps no record of which, and `DEFAULT 'cash'` and a writer passing the string 'cash'
 * produce byte-identical rows. That distinction is what decides "migration vs schema tidy", and it
 * has to be settled in the CODE — which is why the companion scan below reads every insert site
 * rather than guessing from the data.
 *
 * ============================================================================================
 * WHAT "NEVER ASKED" MEANS HERE
 * ============================================================================================
 *
 *   tab_id IS NOT NULL   -> a tab order. The customer pays when the tab is settled at the table;
 *                           the submission screen has no payment-method question at all. Any
 *                           'cash' on these rows was put there by the route, not by a person.
 *
 *   tab_id IS NULL       -> a direct order. The method IS chosen at submission and validated
 *                           against the restaurant's accepted list, so 'cash' here is plausibly a
 *                           real choice. Counted separately and NOT claimed as invented.
 *
 *   channel = 'pos'      -> created by the terminal, which hardcodes paymentMethod: 'card'. These
 *                           should not appear as cash at all; if they do, that is its own finding.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

const countOf = async (build: (q: any) => any) => {
  let q = admin.from('orders').select('id', { count: 'exact', head: true })
  q = build(q)
  const { count, error } = await q
  if (error) throw new Error(`count failed: ${error.message}`)
  return count ?? 0
}

async function main() {
  console.log('\nPRODUCTION — payment_method = cash, and how much of it nobody chose. Read-only.\n')

  const total = await countOf((q) => q)
  console.log(`  [control] orders readable, total rows : ${total}`)
  if (total === 0) {
    console.log('  NOTHING READABLE — every number below would be meaningless. Stopping.')
    return
  }

  // ---------------------------------------------------------------- the whole distribution
  const { data: sample, error: sErr } = await admin
    .from('orders')
    .select('payment_method, payment_status, tab_id, channel, placed_at')
    .order('placed_at', { ascending: false })
    .limit(5000)
  if (sErr) throw new Error(`sample read failed: ${sErr.message}`)

  const byMethod = new Map<string, number>()
  for (const r of sample ?? []) {
    const m = r.payment_method === null ? '(null)' : String(r.payment_method)
    byMethod.set(m, (byMethod.get(m) ?? 0) + 1)
  }
  console.log(`\n  DISTRIBUTION over the ${sample?.length ?? 0} most recent orders:`)
  for (const [m, n] of [...byMethod.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${m.padEnd(14)} ${String(n).padStart(5)}`)
  }

  // ---------------------------------------------------------------- exact counts, whole table
  const cash = await countOf((q) => q.eq('payment_method', 'cash'))
  const cashTab = await countOf((q) => q.eq('payment_method', 'cash').not('tab_id', 'is', null))
  const cashDirect = await countOf((q) => q.eq('payment_method', 'cash').is('tab_id', null))
  const cashPos = await countOf((q) => q.eq('payment_method', 'cash').eq('channel', 'pos'))
  const nullMethod = await countOf((q) => q.is('payment_method', null))
  const tabTotal = await countOf((q) => q.not('tab_id', 'is', null))

  console.log('\n  EXACT COUNTS, whole table:')
  console.log(`      orders total                          : ${total}`)
  console.log(`      payment_method = 'cash'               : ${cash}`)
  console.log(`        of which TAB orders (never asked)   : ${cashTab}`)
  console.log(`        of which DIRECT (plausibly chosen)  : ${cashDirect}`)
  console.log(`        of which channel='pos'              : ${cashPos}   <- terminal hardcodes 'card'; non-zero is its own finding`)
  console.log(`      payment_method IS NULL                : ${nullMethod}`)
  console.log(`      tab orders, any method                : ${tabTotal}`)

  // ---------------------------------------------------------------- the derived badge
  const cashPendingTab = await countOf((q) =>
    q.eq('payment_status', 'cash_pending').not('tab_id', 'is', null),
  )
  console.log(`\n      tab orders with payment_status='cash_pending' : ${cashPendingTab}`)
  console.log(`        ^ the badge DERIVED from the invented method: 'cash' && no channel -> cash_pending`)

  // ---------------------------------------------------------------- is it still happening?
  const { data: recent } = await admin
    .from('orders')
    .select('id, placed_at, payment_status, channel')
    .eq('payment_method', 'cash')
    .not('tab_id', 'is', null)
    .order('placed_at', { ascending: false })
    .limit(5)
  console.log('\n  MOST RECENT tab orders stamped cash:')
  for (const r of recent ?? []) {
    console.log(`      ${r.placed_at}   ${String(r.channel).padEnd(8)} ${r.payment_status}`)
  }
  if (!recent?.length) console.log('      (none)')

  // ---------------------------------------------------------------- what the numbers mean
  const pct = total > 0 ? ((cashTab / total) * 100).toFixed(1) : '0'
  console.log('\n  READING:')
  console.log(`      ${cashTab} of ${total} orders (${pct}%) are tab orders stamped 'cash' by the route,`)
  console.log(`      not by a customer. ${cashDirect} more are direct orders where cash was a real choice`)
  console.log('      and must NOT be touched by any backfill.')
  console.log('')
  console.log('      Whether the COLUMN DEFAULT ever fired is not visible here — see the insert-site')
  console.log('      scan, which is what actually decides migration vs schema tidy.')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
