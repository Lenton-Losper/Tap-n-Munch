/**
 * #324 — THE RE-COUNT. Production, READ ONLY.
 *
 * Answers all three of the ruling's abort conditions, plus the before/after duplicate-pair count.
 * `delete-324-orphan-orders.ts` re-derives every one of these itself and refuses if any trips, so
 * this script's job is to let a human SEE the numbers before authorising anything.
 */
import { guard, all } from './_guard'

const FIXTURE = /^restaurant_test_/

async function main() {
  const { db } = guard([
    'Reads orders, restaurants and every table that could reference an order.',
    'Writes nothing. Answers:',
    '  - has the count moved materially from 1315',
    '  - does any row resolve to a real restaurant',
    '  - would the delete orphan rows in a table we cannot clean in the same transaction',
    '  - duplicate (restaurant_id, order_number) pairs now and after',
  ])

  const rests = await all<{ id: string; name: string; firebase_id: string | null }>((f, t) =>
    db.from('restaurants').select('id, name, firebase_id').range(f, t),
  )
  const known = new Set(rests.map((r) => String(r.id)))
  const realFirebaseIds = new Set(rests.map((r) => r.firebase_id).filter(Boolean).map(String))
  console.log(`restaurants: ${rests.length}`)

  const orders = await all<{
    id: string
    restaurant_id: string | null
    firebase_restaurant_id: string | null
    order_number: number | null
    total: number | null
    placed_at: string | null
    payment_status: string | null
  }>((f, t) =>
    db
      .from('orders')
      .select('id, restaurant_id, firebase_restaurant_id, order_number, total, placed_at, payment_status')
      .range(f, t),
  )
  console.log(`orders: ${orders.length}`)

  const nullRid = orders.filter((o) => !o.restaurant_id)
  const unknownRid = orders.filter((o) => o.restaurant_id && !known.has(String(o.restaurant_id)))
  const fixture = nullRid.filter((o) => FIXTURE.test(String(o.firebase_restaurant_id ?? '')))
  const nonFixtureNull = nullRid.filter((o) => !FIXTURE.test(String(o.firebase_restaurant_id ?? '')))

  console.log('')
  console.log(`restaurant_id IS NULL              : ${nullRid.length}`)
  console.log(`  of which firebase restaurant_test_%: ${fixture.length}   <- the delete's scope`)
  console.log(`  of which NOT                       : ${nonFixtureNull.length}`)
  console.log(`restaurant_id set but unknown      : ${unknownRid.length}`)

  console.log('')
  console.log('CONDITION 1 — has the count moved materially from 1315?')
  const drift = fixture.length - 1315
  console.log(`  in scope now: ${fixture.length}   (${drift >= 0 ? '+' : ''}${drift} vs 1315)`)

  console.log('')
  console.log('CONDITION 2 — does any in-scope row resolve to a real restaurant?')
  const resolves = fixture.filter((o) => realFirebaseIds.has(String(o.firebase_restaurant_id)))
  console.log(`  rows whose firebase id matches a real restaurant: ${resolves.length}`)
  if (nonFixtureNull.length > 0) {
    const byId: Record<string, number> = {}
    for (const o of nonFixtureNull) {
      const k = String(o.firebase_restaurant_id ?? 'NULL')
      byId[k] = (byId[k] ?? 0) + 1
    }
    console.log(`  NON-FIXTURE null rows present, NOT in scope: ${JSON.stringify(byId)}`)
  }
  const paidInScope = fixture.filter((o) => String(o.payment_status ?? '').toLowerCase() === 'paid')
  console.log(`  in-scope rows marked PAID: ${paidInScope.length}   (a paid row is a financial record)`)

  const dist: Record<string, number> = {}
  for (const o of fixture) {
    const k = String(o.firebase_restaurant_id)
    dist[k] = (dist[k] ?? 0) + 1
  }
  console.log(`  distribution: ${JSON.stringify(dist)}`)
  const dates = fixture.map((o) => o.placed_at).filter(Boolean).sort()
  if (dates.length) console.log(`  date span: ${String(dates[0]).slice(0, 10)} .. ${String(dates[dates.length - 1]).slice(0, 10)}`)

  console.log('')
  console.log('CONDITION 3 — referencing rows, per table')
  const ids = fixture.map((o) => String(o.id))
  const idSet = new Set(ids)
  for (const [table, column] of [
    ['order_items', 'order_id'],
    ['payments', 'order_id'],
    ['receipts', 'order_id'],
    ['receipt_documents', 'order_id'],
    ['audit_logs', 'entity_id'],
    ['order_requests', 'accepted_order_id'],
    ['stock_movements', 'reference_id'],
  ] as const) {
    let n = 0
    let err: string | null = null
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await db.from(table).select('id').in(column, ids.slice(i, i + 100)).limit(1000)
      if (error) {
        err = error.message
        break
      }
      n += (data ?? []).length
    }
    console.log(`  ${(table + '.' + column).padEnd(34)} ${err ? 'ERR ' + err.slice(0, 50) : n}`)
  }

  // Array column — a plain .in() cannot see it.
  const pe = await all<{ id: string; order_ids: string[] | null }>((f, t) =>
    db.from('payment_events').select('id, order_ids').range(f, t),
  )
  const peTouching = pe.filter((e) => Array.isArray(e.order_ids) && e.order_ids.some((x) => idSet.has(String(x))))
  console.log(`  ${'payment_events.order_ids (array)'.padEnd(34)} ${peTouching.length}   of ${pe.length} scanned`)

  // ---------------------------------------------------------------- duplicate pairs
  const pairs = (rows: typeof orders) => {
    const seen = new Map<string, number>()
    for (const o of rows) {
      const k = `${o.restaurant_id ?? 'NULL'}|${o.order_number ?? ''}`
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    return [...seen.values()].filter((n) => n > 1).length
  }
  const survivors = orders.filter((o) => !idSet.has(String(o.id)))
  console.log('')
  console.log('DUPLICATE (restaurant_id, order_number) PAIRS')
  console.log(`  now:          ${pairs(orders)}`)
  console.log(`  after delete: ${pairs(survivors)}   (the ruling expects 282 -> 3)`)

  console.log('')
  console.log('PROBE_324_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
