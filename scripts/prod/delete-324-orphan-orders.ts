/**
 * #324 — THE DELETE. Production. WRITES. One-off.
 *
 * Removes legacy Firebase-era fixture orders: `restaurant_id IS NULL` AND
 * `firebase_restaurant_id LIKE 'restaurant_test_%'`.
 *
 * ============================================================================================
 * IT RE-DERIVES EVERY ABORT CONDITION ITSELF AND REFUSES IF ANY TRIPS.
 * ============================================================================================
 *
 * Running the probe first is for a human to see the numbers. It is NOT the gate. This script does
 * not read the probe's output, does not accept a count as an argument, and cannot be told to skip a
 * check — because a delete authorised by a number someone typed is a delete authorised by nothing.
 *
 * The conditions, all from the ruling:
 *
 *   1. the in-scope count has moved materially from 1315   (tolerance below, stated not implied)
 *   2. any in-scope row resolves to a real restaurant
 *   3. the delete would orphan rows in a table this script cannot clean in the same statement
 *
 * Two more of my own, because they are the same class and cost nothing:
 *
 *   4. any in-scope row is marked PAID  -- a paid row is a financial record, whatever else it is
 *   5. any NULL-restaurant row does NOT match the fixture pattern -- it means the population is not
 *      what the ruling described, and the scope should be re-agreed rather than assumed
 *
 * NOT A REUSABLE DELETE PATH, per the ruling. The predicate is hard-coded, there is no argument that
 * widens it, and it is scoped to this one shape.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/prod/delete-324-orphan-orders.ts             # dry run
 *   node node_modules/tsx/dist/cli.mjs scripts/prod/delete-324-orphan-orders.ts --confirm   # apply
 */
import { guard, all } from './_guard'

const FIXTURE = /^restaurant_test_/
const EXPECTED = 1315
/** "Materially" made explicit. A drift beyond this means the population changed and a human decides. */
const TOLERANCE = 25

async function main() {
  const { db, confirmed } = guard(
    [
      'Deletes orders where restaurant_id IS NULL AND firebase_restaurant_id matches',
      "'restaurant_test_%'. Legacy Firebase fixture data.",
      '',
      'It re-derives all five preconditions here and REFUSES if any trips. It does not',
      'read the probe output and cannot be told to skip a check.',
    ],
    true,
  )

  const rests = await all<{ id: string; firebase_id: string | null }>((f, t) =>
    db.from('restaurants').select('id, firebase_id').range(f, t),
  )
  const realFirebaseIds = new Set(rests.map((r) => r.firebase_id).filter(Boolean).map(String))

  const orders = await all<{
    id: string
    restaurant_id: string | null
    firebase_restaurant_id: string | null
    payment_status: string | null
    total: number | null
  }>((f, t) =>
    db.from('orders').select('id, restaurant_id, firebase_restaurant_id, payment_status, total').range(f, t),
  )

  const nullRid = orders.filter((o) => !o.restaurant_id)
  const inScope = nullRid.filter((o) => FIXTURE.test(String(o.firebase_restaurant_id ?? '')))
  const ids = inScope.map((o) => String(o.id))
  const idSet = new Set(ids)

  const failures: string[] = []

  // ---- 1
  const drift = Math.abs(inScope.length - EXPECTED)
  console.log(`1. in-scope count: ${inScope.length}  (expected ~${EXPECTED}, tolerance ${TOLERANCE}, drift ${drift})`)
  if (drift > TOLERANCE) failures.push(`count moved materially: ${inScope.length} vs ${EXPECTED}`)

  // ---- 2
  const resolves = inScope.filter((o) => realFirebaseIds.has(String(o.firebase_restaurant_id)))
  console.log(`2. in-scope rows resolving to a real restaurant: ${resolves.length}`)
  if (resolves.length > 0) failures.push(`${resolves.length} row(s) resolve to a real restaurant`)

  // ---- 4
  const paid = inScope.filter((o) => String(o.payment_status ?? '').toLowerCase() === 'paid')
  console.log(`4. in-scope rows marked PAID: ${paid.length}`)
  if (paid.length > 0) failures.push(`${paid.length} in-scope row(s) are marked paid — financial records`)

  // ---- 5
  const nonFixture = nullRid.length - inScope.length
  console.log(`5. NULL-restaurant rows NOT matching the fixture pattern: ${nonFixture}`)
  if (nonFixture > 0) {
    failures.push(`${nonFixture} NULL-restaurant row(s) are not fixture rows — the population is not as described`)
  }

  // ---- 3
  console.log('3. referencing rows, per table:')
  const CLEANABLE = new Set(['order_items'])
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
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await db.from(table).select('id').in(column, ids.slice(i, i + 100)).limit(1000)
      if (error) {
        failures.push(`cannot check ${table}.${column}: ${error.message}`)
        n = -1
        break
      }
      n += (data ?? []).length
    }
    console.log(`     ${(table + '.' + column).padEnd(34)} ${n < 0 ? 'UNCHECKED' : n}`)
    if (n > 0 && !CLEANABLE.has(table)) {
      failures.push(`${n} row(s) in ${table} reference these orders and this script does not clean ${table}`)
    }
  }

  const pe = await all<{ id: string; order_ids: string[] | null }>((f, t) =>
    db.from('payment_events').select('id, order_ids').range(f, t),
  )
  const peTouching = pe.filter((e) => Array.isArray(e.order_ids) && e.order_ids.some((x) => idSet.has(String(x))))
  console.log(`     ${'payment_events.order_ids (array)'.padEnd(34)} ${peTouching.length}`)
  if (peTouching.length > 0) failures.push(`${peTouching.length} payment_events row(s) name these orders`)

  // ---------------------------------------------------------------- verdict
  console.log('')
  if (failures.length > 0) {
    console.log('='.repeat(78))
    console.log('REFUSING TO DELETE. Preconditions that did not hold:')
    console.log('='.repeat(78))
    for (const f of failures) console.log('  - ' + f)
    console.log('')
    console.log('Nothing was changed. These are the conditions the ruling set; a human decides now.')
    process.exit(2)
  }

  console.log('All preconditions hold.')
  if (!confirmed) {
    console.log('')
    console.log(`DRY RUN — would delete ${ids.length} order(s) and their order_items.`)
    console.log('Re-run with --confirm to apply.')
    return
  }

  // order_items first: the FK direction means an orphaned child is possible.
  let itemsDeleted = 0
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100)
    const { data, error } = await db.from('order_items').delete().in('order_id', slice).select('id')
    if (error) throw new Error(`order_items delete failed after ${itemsDeleted}: ${error.message}`)
    itemsDeleted += (data ?? []).length
  }
  console.log(`deleted order_items: ${itemsDeleted}`)

  let deleted = 0
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100)
    const { data, error } = await db.from('orders').delete().in('id', slice).select('id')
    if (error) throw new Error(`orders delete failed after ${deleted}: ${error.message}`)
    deleted += (data ?? []).length
  }
  console.log(`deleted orders: ${deleted}`)

  // ---------------------------------------------------------------- prove the effect
  const after = await all<{ id: string; restaurant_id: string | null; firebase_restaurant_id: string | null; order_number: number | null }>(
    (f, t) => db.from('orders').select('id, restaurant_id, firebase_restaurant_id, order_number').range(f, t),
  )
  const remaining = after.filter((o) => !o.restaurant_id && FIXTURE.test(String(o.firebase_restaurant_id ?? '')))
  const seen = new Map<string, number>()
  for (const o of after) {
    const k = `${o.restaurant_id ?? 'NULL'}|${o.order_number ?? ''}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  console.log('')
  console.log(`orders remaining in scope: ${remaining.length}   (expect 0)`)
  console.log(`orders table now: ${after.length}`)
  console.log(`duplicate (restaurant_id, order_number) pairs: ${[...seen.values()].filter((n) => n > 1).length}   (the ruling expects 3)`)
  console.log('')
  console.log('DELETE_324_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
