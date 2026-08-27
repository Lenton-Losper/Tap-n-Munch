/**
 * WHY IS THE VAT SPLIT WRONG ON A PAID RECEIPT? Production, order #10, strictly read-only.
 *
 * Reported from the printed receipt:
 *
 *     1x coffee        NAD  50.00
 *     1x Pork Star     NAD 240.00
 *     Subtotal         NAD 277.88
 *     VAT              NAD  12.12
 *     TOTAL            NAD 290.00
 *
 * 277.88 + 12.12 = 290.00, so the TOTAL is right and the SPLIT is wrong. At a 15% INCLUSIVE rate
 * the VAT on 290 is 290 - (290 / 1.15) = 37.83, and the subtotal 252.17.
 *
 * 12.12 is not a rounding error, it is a different rate. Working backwards: if only the coffee
 * were standard-rated at 15% inclusive its VAT would be 6.52; if only the Pork Star, 31.30. 12.12
 * corresponds to roughly 4.4% on 290, or to one line at a low per-item rate.
 *
 * TWO CANDIDATE EXPLANATIONS, and this probe separates them rather than arguing:
 *
 *   DATA        one of those menu items carries a tax_rate_id pointing at a rate that is not 15,
 *               or is zero-rated, and the arithmetic is faithfully applying it. Then the fix is in
 *               the restaurant's dashboard and is the human's to make.
 *   CALCULATION the rates are right and the split is computed wrongly — a mixed-basis bug, an
 *               exclusive rate applied inclusively, or tax summed from the wrong field. Then it is
 *               a defect and ships alone.
 *
 * WHAT IS READ: the order row and its stored lines, the tax_rates for that restaurant, and the
 * menu_items those lines point at. Selects only. No writes, no fixture, production is not a test
 * environment.
 */
/**
 * #324 — the `order_number = 10` lookup now excludes the stress fixtures, and it needed to.
 *
 * `order_number` IS NOT A NARROWING FILTER on this table. The 1,314 seeded fixtures occupy order
 * numbers 1..146 with up to 45 rows on a single number, all with `restaurant_id IS NULL`.
 * Measured read-only on production 2026-08-27: `order_number = 10` matches SIX rows, and TWO of
 * them are fixtures. This file prints `orders numbered 10 : N` and then dumps each one's VAT
 * split, so a third of what it showed was a `total = 0` seeded row.
 *
 * It is the same defect that put 8 fixtures in a page of 10 on the platform order search
 * (fixed at 6c777e3d), arriving through the same door: a lookup that reads like an identity and
 * is not one.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { excludeStressFixtures } from '../lib/orders/stress-fixtures'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN)
const r2 = (v: number) => Math.round(v * 100) / 100

async function main() {
  console.log('\nPRODUCTION — the VAT split on order #10, read-only\n')

  const { data: ctl, error: ctlErr } = await admin.from('orders').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] orders readable and non-empty : ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  const { data: orders, error } = await excludeStressFixtures(
    admin
      .from('orders')
      .select('id, order_number, restaurant_id, table_number, status, payment_status, payment_method, subtotal, tax, total, items, placed_at')
      .eq('order_number', 10)
      .order('placed_at', { ascending: false })
      .limit(5),
  )
  if (error) throw new Error(`order read failed: ${error.message}`)
  if (!orders?.length) {
    console.log('  no order with order_number = 10 — nothing to analyse')
    return
  }
  console.log(`  orders numbered 10                     : ${orders.length}`)

  for (const o of orders) {
    console.log(`\n${'='.repeat(76)}`)
    console.log(`ORDER ${o.id}   #${o.order_number}   table ${o.table_number}   ${o.placed_at}`)
    console.log(`  status=${o.status} payment=${o.payment_status}/${o.payment_method}`)
    console.log(`  STORED HEADER   subtotal=${o.subtotal}  tax=${o.tax}  total=${o.total}`)
    const headerSum = r2(n(o.subtotal) + n(o.tax))
    console.log(`  subtotal + tax  = ${headerSum}   (total is ${o.total} — ${headerSum === r2(n(o.total)) ? 'consistent' : 'INCONSISTENT'})`)

    const inclusive15 = r2(n(o.total) - n(o.total) / 1.15)
    console.log(`  VAT if the WHOLE total were 15% inclusive : ${inclusive15}   (receipt shows ${o.tax})`)

    const lines = Array.isArray(o.items) ? o.items : []
    console.log(`\n  LINES (${lines.length}):`)
    let sumSub = 0
    let sumTax = 0
    let sumTot = 0
    for (const l of lines) {
      sumSub += n(l.subtotal) || 0
      sumTax += n(l.tax) || 0
      sumTot += n(l.total) || 0
      console.log(
        `    ${String(l.name ?? l.displayName ?? '?').padEnd(24)} qty=${l.quantity}  unit=${l.unitPrice}` +
          `  sub=${l.subtotal}  tax=${l.tax}  total=${l.total}` +
          `  rate=${l.taxRatePercentage}  inclusive=${l.taxInclusive}  rateId=${l.taxRateId ?? 'null'}`,
      )
      const lineTotal = n(l.total)
      const lineRate = n(l.taxRatePercentage)
      if (Number.isFinite(lineTotal) && Number.isFinite(lineRate) && lineRate > 0) {
        const expectedInclusive = r2(lineTotal - lineTotal / (1 + lineRate / 100))
        console.log(
          `      -> at ${lineRate}% INCLUSIVE the tax on ${lineTotal} would be ${expectedInclusive}` +
            `  (stored ${l.tax}${r2(n(l.tax)) === expectedInclusive ? ' — matches' : ' — DIFFERS'})`,
        )
      }
    }
    console.log(`\n  LINE SUMS       subtotal=${r2(sumSub)}  tax=${r2(sumTax)}  total=${r2(sumTot)}`)
    console.log(
      `  header vs lines : subtotal ${r2(sumSub) === r2(n(o.subtotal)) ? 'agree' : 'DISAGREE'}, ` +
        `tax ${r2(sumTax) === r2(n(o.tax)) ? 'agree' : 'DISAGREE'}, ` +
        `total ${r2(sumTot) === r2(n(o.total)) ? 'agree' : 'DISAGREE'}`,
    )

    // The menu items and rates those lines point at.
    const ids = [...new Set(lines.map((l) => String(l.menuItemId ?? l.menu_item_id ?? '')).filter(Boolean))]
    if (ids.length) {
      const { data: items } = await admin
        .from('menu_items')
        .select('id, name, base_price, tax_rate_id')
        .in('id', ids)
      console.log('\n  MENU ITEMS as configured today:')
      const rateIds = [...new Set((items ?? []).map((i) => i.tax_rate_id).filter(Boolean))]
      const { data: rates } = rateIds.length
        ? await admin.from('tax_rates').select('id, name, percentage, is_inclusive, is_default').in('id', rateIds)
        : { data: [] }
      const rateById = new Map((rates ?? []).map((r) => [String(r.id), r]))
      for (const i of items ?? []) {
        const rt = i.tax_rate_id ? rateById.get(String(i.tax_rate_id)) : null
        console.log(
          `    ${String(i.name).padEnd(24)} base=${i.base_price}  tax_rate_id=${i.tax_rate_id ?? 'null'}` +
            (rt ? `  -> ${rt.name} ${rt.percentage}% inclusive=${rt.is_inclusive} default=${rt.is_default}` : '  -> (no rate row)'),
        )
      }
    }

    /**
     * `is_active` DOES NOT EXIST on tax_rates — the columns are id, restaurant_id, name,
     * percentage, is_inclusive, is_default, created_at. Selecting it made PostgREST error, and
     * the first run of this probe printed an EMPTY rate list because the error was never checked.
     * A silent empty result read as "this restaurant has no tax rates", which would have been a
     * finding in itself. Errors are surfaced now.
     */
    const { data: allRates, error: ratesErr } = await admin
      .from('tax_rates')
      .select('id, name, percentage, is_inclusive, is_default')
      .eq('restaurant_id', o.restaurant_id)
    if (ratesErr) console.log(`    RATE READ FAILED: ${ratesErr.message}`)
    console.log('\n  EVERY TAX RATE on this restaurant:')
    for (const r of allRates ?? []) {
      console.log(
        `    ${String(r.name).padEnd(24)} ${r.percentage}%  inclusive=${r.is_inclusive}  default=${r.is_default}  active=${r.is_active}`,
      )
    }
  }

  console.log(
    '\n  HOW TO READ THIS. If a line\'s stored tax MATCHES its own stored rate, the arithmetic is\n' +
      '  faithful and the rate is the problem — a DATA fix in the dashboard. If a line\'s stored tax\n' +
      '  differs from its own rate, or the header disagrees with the line sums, it is a CALCULATION\n' +
      '  defect.',
  )
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
