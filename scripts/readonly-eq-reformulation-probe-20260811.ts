/**
 * READ ONLY. The second half of #242's proof, and the answer to the question that blocked it:
 * "we cannot sanitise, because we do not know what charset Finatic can put in out_trade_no."
 *
 *   npx tsx scripts/readonly-eq-reformulation-probe-20260811.ts
 *
 * Companion to scripts/readonly-or-injection-probe-20260811.ts, which established the defect
 * (benign 0 rows -> injected 213 rows across 2 restaurants). This one establishes the FIX, and
 * establishes that the charset question never had to be answered:
 *
 *   1. NEGATIVE — 13 injection payloads through both formulations. The .or() widens; the two
 *      .eq() queries do not.
 *   2. POSITIVE — six references that really exist. The reformulation must return the IDENTICAL
 *      id set, or 213 -> 0 is just a broken function rather than a fix.
 *   3. CENSUS — every stored value in the three columns the resolver reads, checked against
 *      isWellFormedPaymentRef. This is the direct measurement of "a sanitiser would fail closed
 *      on a legitimate value": if nothing stored would be rejected, the fear has a number.
 *
 * Every orders / payment_events call is a .select(). The counting calls use
 * { head: true, count: 'exact' } so no row content is read into the process; the census selects
 * ONLY the two reference columns and the positive control selects ONLY `id`. No customer names,
 * no totals, no writes anywhere.
 *
 * STAGING ONLY, allowlisted before the client is constructed.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { isWellFormedPaymentRef } from '../lib/guest-orders/validation'

config({ path: `${process.cwd()}/.env.test`, override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

const url = String(process.env.SUPABASE_URL || '').trim()
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || ''

if (!ref) throw new Error(`Could not parse a project ref from SUPABASE_URL (${url || 'unset'})`)
if (ref === PRODUCTION_REF) throw new Error(`REFUSING: SUPABASE_URL points at PRODUCTION (${ref})`)
if (ref !== STAGING_REF) throw new Error(`REFUSING: ref ${ref} is not the allowlisted staging ref ${STAGING_REF}`)
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is unset')

console.log(`[guard] ok — staging ref ${ref} (READ ONLY)`)

const supabase = createClient(url, key, { auth: { persistSession: false } })

/** The vulnerable expression, verbatim from the pre-#242 resolver. */
const vulnerableFilter = (mo: string) => `paycloud_merchant_order_no.eq.${mo},payment_reference.eq.${mo}`

const REFERENCE_COLUMNS = ['paycloud_merchant_order_no', 'payment_reference'] as const

async function countViaOr(mo: string): Promise<number | string> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .or(vulnerableFilter(mo))
  return error ? `ERROR: ${error.message}` : (count ?? 0)
}

/** The shipped formulation: one .eq() per column, unioned. */
async function countViaTwoEq(mo: string): Promise<string> {
  const counts: number[] = []
  for (const column of REFERENCE_COLUMNS) {
    const { count, error } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq(column, mo)
    if (error) return `ERROR(${column}): ${error.message}`
    counts.push(count ?? 0)
  }
  return `${counts.reduce((a, b) => a + b, 0)}  (${REFERENCE_COLUMNS.map((c, i) => `${c}=${counts[i]}`).join(', ')})`
}

async function idsViaOr(mo: string): Promise<string[]> {
  const { data, error } = await supabase.from('orders').select('id').or(vulnerableFilter(mo))
  if (error) throw new Error(error.message)
  return [...new Set((data ?? []).map((r) => String(r.id)))].sort()
}

async function idsViaTwoEq(mo: string): Promise<string[]> {
  const found: string[] = []
  for (const column of REFERENCE_COLUMNS) {
    const { data, error } = await supabase.from('orders').select('id').eq(column, mo)
    if (error) throw new Error(error.message)
    found.push(...(data ?? []).map((r) => String(r.id)))
  }
  return [...new Set(found)].sort()
}

/**
 * Payloads aimed at the FIX, not at the old code: each one is an attempt to make a single-column
 * .eq() match something it should not, or to change the operator out from under it.
 */
const PAYLOADS: Array<[string, string]> = [
  ['plain injected comma', 'NONEXISTENT-REF-ZZZZZZ,id.not.is.null'],
  ['pre-percent-encoded comma', 'NONEXISTENT-REF-ZZZZZZ%2Cid.not.is.null'],
  ['double-quote wrapper', '"NONEXISTENT",id.not.is.null'],
  ['unterminated double quote', '"NONEXISTENT'],
  ['leading paren group', '(id.not.is.null)'],
  ['operator hijack attempt', 'not.is.null'],
  ['like wildcard', '*'],
  ['sql-ish wildcard', '%'],
  ['null literal', 'null'],
  ['and-tree attempt', 'x&id=not.is.null'],
  ['newline then comma', 'x\n,id.not.is.null'],
  ['PayCloud-legal charset our validator rejects', 'FT_1785157965*7531677@x'],
]

async function main() {
  const { count: totalOrders } = await supabase.from('orders').select('id', { count: 'exact', head: true })
  console.log(`\norders on staging: ${totalOrders}   (anything above 1 in the columns below is a widening)`)

  console.log(`\n=== 1. NEGATIVE — injection payloads through both formulations ===`)
  for (const [label, value] of PAYLOADS) {
    console.log(`\n  ${label}`)
    console.log(`    value          = ${JSON.stringify(value)}`)
    console.log(`    wellFormedRef  = ${isWellFormedPaymentRef(value)}`)
    console.log(`    BEFORE .or()   -> ${await countViaOr(value)}`)
    console.log(`    AFTER two .eq()-> ${await countViaTwoEq(value)}`)
  }

  console.log(`\n=== 2. POSITIVE — references that really exist must resolve IDENTICALLY ===`)
  const samples: Array<[string, string]> = []
  for (const column of REFERENCE_COLUMNS) {
    const { data } = await supabase.from('orders').select(column).not(column, 'is', null).limit(3)
    for (const row of data ?? []) samples.push([column, String((row as Record<string, unknown>)[column])])
  }
  let allAgree = true
  for (const [column, value] of samples) {
    const before = await idsViaOr(value)
    const after = await idsViaTwoEq(value)
    const same = JSON.stringify(before) === JSON.stringify(after)
    allAgree = allAgree && same && before.length > 0
    console.log(`\n  real ${column} = ${JSON.stringify(value)}`)
    console.log(`    BEFORE .or()    -> ${before.length} row(s)`)
    console.log(`    AFTER two .eq() -> ${after.length} row(s)`)
    console.log(
      `    IDENTICAL ID SET: ${same}${before.length === 0 ? '   <-- WARNING: zero rows, not a positive control' : ''}`,
    )
  }
  console.log(`\n  every sampled reference agreed, and matched at least one row: ${allAgree}`)

  console.log(`\n=== 3. CENSUS — would a charset validator refuse anything we have actually stored? ===`)
  const { data: rows, error: censusError } = await supabase
    .from('orders')
    .select(REFERENCE_COLUMNS.join(', '))
  if (censusError) {
    console.log(`  ERROR: ${censusError.message}`)
  } else {
    for (const column of REFERENCE_COLUMNS) {
      const present = (rows ?? []).filter((r) => String((r as Record<string, unknown>)[column] ?? '').trim() !== '')
      const rejected = present.filter((r) => !isWellFormedPaymentRef(String((r as Record<string, unknown>)[column])))
      const punctuation = new Set<string>()
      for (const r of present) {
        for (const ch of String((r as Record<string, unknown>)[column])) {
          if (!/[A-Za-z0-9]/.test(ch)) punctuation.add(ch)
        }
      }
      console.log(`\n  orders.${column}`)
      console.log(`    non-empty values           : ${present.length} of ${(rows ?? []).length}`)
      console.log(`    WOULD BE REJECTED          : ${rejected.length}`)
      console.log(`    non-alphanumerics observed : ${JSON.stringify([...punctuation])}`)
      for (const r of rejected.slice(0, 10)) {
        console.log(`      REJECTED: ${JSON.stringify((r as Record<string, unknown>)[column])}`)
      }
    }
  }

  const { data: events, error: eventsError } = await supabase.from('payment_events').select('business_order_no')
  if (eventsError) {
    console.log(`\n  payment_events ERROR: ${eventsError.message}`)
  } else {
    const present = (events ?? []).filter((r) => String(r.business_order_no ?? '').trim() !== '')
    const rejected = present.filter((r) => !isWellFormedPaymentRef(String(r.business_order_no)))
    console.log(`\n  payment_events.business_order_no`)
    console.log(`    non-empty values  : ${present.length} of ${(events ?? []).length}`)
    console.log(`    WOULD BE REJECTED : ${rejected.length}`)
  }

  console.log(
    `\nRead the census with its power: it is STAGING. It shows the fear is not realised on the data\n` +
      `this project holds; it is not a statement about production, which was not measured.`,
  )
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
