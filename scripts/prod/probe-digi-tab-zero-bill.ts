/**
 * READ-ONLY. Digi Cofee, Table 1: the bill reads NAD 0.00 and the status renders as paid-in-full
 * while no payment was ever taken. Two candidate causes, and this script only distinguishes them:
 *
 *   1. the tab total is not summing rounds sent through the waiter flow, so a tab that OWES money
 *      displays zero -- a waiter closes the table and the venue loses the money;
 *   2. something actually marked orders #30 and #31 paid.
 *
 * SELECTs only. Fixes nothing, decides nothing.
 *
 * Every query prints its own error. The first version of this script selected a column production
 * does not have, PostgREST returned null with an error nobody printed, and the output read as
 * "no such orders" -- which is a different and far more alarming finding than "bad column name".
 */
import { guard } from './_guard'

function show(label: string, data: unknown, error: unknown) {
  console.log('\n' + label + ':')
  if (error) {
    console.log('  QUERY ERROR:', JSON.stringify(error))
    return
  }
  console.log(JSON.stringify(data, null, 2))
}

async function main() {
  const { db } = guard([
    'Digi Cofee -> orders #30 and #31, their tab, and their order_lines.',
    'Prints totals, payment_status, paid_at, settled_at, and every line.',
  ])

  const r = await db.from('restaurants').select('id, name').ilike('name', '%digi%')
  show('RESTAURANTS MATCHING "digi"', r.data, r.error)
  const rid = String((r.data as any[])?.[0]?.id ?? '')
  if (!rid) return console.log('No Digi restaurant found -- stopping.')

  const o = await db
    .from('orders')
    .select('id, order_number, table_number, tab_id, total, payment_status, status, paid_at, placed_at')
    .eq('restaurant_id', rid)
    .in('order_number', [30, 31])
  show('ORDERS #30 / #31', o.data, o.error)

  const orders = (o.data as any[]) ?? []
  const tabIds = [...new Set(orders.map((x) => x.tab_id).filter(Boolean))]

  if (tabIds.length) {
    const t = await db
      .from('tabs')
      .select('id, table_id, status, total, settled_at, created_at')
      .in('id', tabIds)
    show('TAB(S)', t.data, t.error)

    // Every order on the tab, not only 30/31: if the tab total disagrees with the sum of its
    // orders, the missing money may sit on an order the report did not name.
    const all = await db
      .from('orders')
      .select('order_number, total, payment_status, paid_at, placed_at')
      .in('tab_id', tabIds)
      .order('order_number')
    show('EVERY ORDER ON THAT TAB', all.data, all.error)
    if (!all.error) {
      const sum = ((all.data as any[]) ?? []).reduce((s, x) => s + Number(x.total ?? 0), 0)
      console.log('\nSUM OF ORDER TOTALS ON TAB:', sum)
    }
  } else {
    console.log('\nNO tab_id on those orders -- they are not attached to a tab at all.')
  }

  const orderIds = orders.map((x) => x.id)
  if (orderIds.length) {
    const l = await db
      .from('order_lines')
      .select('order_id, name_snapshot, quantity, route_to, kitchen_state, bar_state, created_at')
      .in('order_id', orderIds)
    show('ORDER_LINES ON #30 / #31', l.data, l.error)

    const p = await db
      .from('payments')
      .select('order_id, tab_id, amount, status, created_at')
      .in('order_id', orderIds)
    show('PAYMENT ROWS AGAINST THOSE ORDERS', p.data, p.error)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
