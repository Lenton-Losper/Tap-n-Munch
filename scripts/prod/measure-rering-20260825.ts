// @ts-nocheck
/**
 * READ ONLY. HOW OFTEN IS A SALE RE-RUNG AFTER AN ATTEMPT THAT DID NOT SETTLE — and how long does
 * the operator wait before doing it.
 *
 * THE DEFINITION, stated so it can be argued with. A re-ring is a pair of orders at the SAME venue
 * with the SAME total, where the earlier one never settled (it is pending or cancelled, and carries
 * no payment marker) and a later one was placed within the window. It is a heuristic: two customers
 * buying the same N$35 coffee two minutes apart at the same till would count. The false-positive
 * rate is bounded below by reporting, for each window, how many SETTLED orders have a same-total
 * neighbour in the same window — that is what coincidence alone looks like at this venue.
 *
 * THE INTERVAL IS THE PRODUCT. The gap between the stranded order and its replacement is how long
 * staff waited before deciding the app was stuck. That number, not the count, is the design input.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const WINDOW_MIN = 5

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production')
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })

  const { data: venues } = await db.from('restaurants').select('id,name')
  const byId = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()
  const orders = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db
      .from('orders')
      .select('id,restaurant_id,order_number,total,status,payment_status,payment_method,payment_channel,channel,placed_at,payment_reference,payment_voucher_no,paycloud_merchant_order_no,cancelled_at')
      .gte('placed_at', since)
      .order('placed_at')
      .range(f, f + 999)
    if (error) throw new Error(error.message)
    orders.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  console.log('orders in the last 60 days: ' + orders.length)

  const settled = (o) => o.payment_status === 'paid'
  const stranded = (o) =>
    o.payment_method !== 'cash' &&
    !o.payment_reference &&
    !o.payment_voucher_no &&
    (o.payment_status === 'pending' || o.payment_status === 'cancelled')

  const perVenue = new Map()
  const intervals = []
  const examples = []

  const byVenue = new Map()
  for (const o of orders) {
    if (!byVenue.has(o.restaurant_id)) byVenue.set(o.restaurant_id, [])
    byVenue.get(o.restaurant_id).push(o)
  }

  for (const [rid, list] of byVenue) {
    list.sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at))
    const cardSales = list.filter((o) => o.payment_method !== 'cash')
    let reRings = 0
    let coincidence = 0

    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      const t = new Date(a.placed_at).getTime()
      // the nearest later order at this venue with the same total, inside the window
      let partner = null
      for (let j = i + 1; j < list.length; j++) {
        const dt = new Date(list[j].placed_at).getTime() - t
        if (dt > WINDOW_MIN * 60000) break
        if (Number(list[j].total) === Number(a.total)) { partner = list[j]; break }
      }
      if (!partner) continue
      if (stranded(a)) {
        reRings++
        const gapS = (new Date(partner.placed_at).getTime() - t) / 1000
        intervals.push(gapS)
        examples.push({
          venue: byId.get(rid) ?? rid.slice(0, 8),
          at: String(a.placed_at).slice(0, 19),
          from: a.order_number, fromStatus: a.payment_status,
          to: partner.order_number, toStatus: partner.payment_status,
          total: a.total, gapS,
        })
      } else if (settled(a)) {
        // Same shape, but the first one DID settle -- so it cannot be a re-ring. This is the
        // coincidence floor: same-total neighbours that occur for ordinary reasons.
        coincidence++
      }
    }
    const strandedN = list.filter(stranded).length
    const settledN = list.filter(settled).length
    perVenue.set(rid, {
      name: byId.get(rid) ?? rid.slice(0, 8), cardSales: cardSales.length,
      reRings, coincidence, strandedN, settledN, total: list.length,
    })
  }

  console.log('\n' + '='.repeat(94))
  console.log('RE-RING RATE, last 60 days, ' + WINDOW_MIN + '-minute window')
  console.log('='.repeat(94))
  console.log('  THE TWO RATES ARE CONDITIONAL AND SHARE A SHAPE, so they are comparable:')
  console.log('    followed | STRANDED  = how often a non-settling order is followed by a same-total order')
  console.log('    followed | SETTLED   = how often that happens for no reason at all (the coincidence floor)')
  console.log('  A venue where the two are equal shows no evidence of re-ringing at all.')
  console.log('  venue                  orders  stranded  followed|STRANDED   settled  followed|SETTLED   lift')
  const rows = [...perVenue.values()].sort((a, b) => b.reRings - a.reRings)
  for (const r of rows) {
    if (r.total === 0) continue
    const pStranded = r.strandedN ? (100 * r.reRings) / r.strandedN : 0
    const pSettled = r.settledN ? (100 * r.coincidence) / r.settledN : 0
    console.log(
      '  ' + r.name.slice(0, 22).padEnd(23) +
        String(r.total).padEnd(8) +
        String(r.strandedN).padEnd(10) +
        (r.reRings + '/' + r.strandedN + ' = ' + pStranded.toFixed(0) + '%').padEnd(20) +
        String(r.settledN).padEnd(9) +
        (r.coincidence + '/' + r.settledN + ' = ' + pSettled.toFixed(0) + '%').padEnd(19) +
        (pSettled > 0 ? (pStranded / pSettled).toFixed(1) + 'x' : '-'),
    )
  }

  intervals.sort((a, b) => a - b)
  const pct = (p) => (intervals.length ? intervals[Math.min(intervals.length - 1, Math.floor((p / 100) * intervals.length))] : 0)
  console.log('\n' + '='.repeat(94))
  console.log('THE INTERVAL — how long staff wait before re-ringing  (n=' + intervals.length + ')')
  console.log('='.repeat(94))
  if (intervals.length) {
    console.log('  fastest ' + intervals[0].toFixed(0) + 's    p25 ' + pct(25).toFixed(0) +
      's    MEDIAN ' + pct(50).toFixed(0) + 's    p75 ' + pct(75).toFixed(0) +
      's    p90 ' + pct(90).toFixed(0) + 's    slowest ' + intervals[intervals.length - 1].toFixed(0) + 's')
    const under60 = intervals.filter((s) => s <= 60).length
    const under30 = intervals.filter((s) => s <= 30).length
    console.log('  within 30s: ' + under30 + '/' + intervals.length + ' (' + ((100 * under30) / intervals.length).toFixed(0) + '%)' +
      '     within 60s: ' + under60 + '/' + intervals.length + ' (' + ((100 * under60) / intervals.length).toFixed(0) + '%)')
  }

  console.log('\n  most recent 20:')
  for (const e of examples.slice(-20).reverse()) {
    console.log('   ' + e.at + '  ' + e.venue.slice(0, 20).padEnd(21) +
      '#' + e.from + '(' + e.fromStatus + ') -> #' + e.to + '(' + e.toStatus + ')  N$' +
      String(e.total).padEnd(6) + ' after ' + e.gapS.toFixed(0) + 's')
  }

  console.log('\nRERING_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
