/**
 * #324 — RE-COUNT BEFORE TOUCHING ANYTHING. READ ONLY.
 *
 * The ruling's abort conditions are all questions about the CURRENT state, so none of them can be
 * answered from the issue text:
 *   - has the count moved materially from 1315?
 *   - does any row resolve to a real restaurant?
 *   - would the delete orphan rows in a table that cannot be cleaned in the same transaction?
 *
 * This answers all three, plus the duplicate-pair count the ruling expects to fall 282 -> 3.
 *
 * #324 is filed against PRODUCTION. This runs wherever it is pointed and says which, so the
 * distinction cannot be lost.
 *
 * Marker: PROBE_324_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

async function all(q) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

async function probe(url, key) {
  const which = url.includes(PRODUCTION_REF) ? 'PRODUCTION' : url.includes(STAGING_REF) ? 'STAGING' : 'UNKNOWN'
  console.log('='.repeat(78))
  console.log(which + '  ' + url)
  console.log('='.repeat(78))
  const db = createClient(url, key, { auth: { persistSession: false } })

  const rests = await all((f, t) => db.from('restaurants').select('id, name').range(f, t))
  const known = new Set(rests.map((r) => r.id))
  console.log('restaurants: ' + rests.length)

  const orders = await all((f, t) =>
    db.from('orders').select('id, restaurant_id, firebase_restaurant_id, tab_id, placed_at, total, order_number').range(f, t),
  )
  console.log('orders total: ' + orders.length)

  const orphans = orders.filter((o) => !o.restaurant_id || !known.has(o.restaurant_id))
  const nullRid = orphans.filter((o) => !o.restaurant_id)
  const unknownRid = orphans.filter((o) => o.restaurant_id && !known.has(o.restaurant_id))
  console.log('\norphan orders (null or unknown restaurant_id): ' + orphans.length)
  console.log('  restaurant_id IS NULL:      ' + nullRid.length)
  console.log('  restaurant_id set, unknown: ' + unknownRid.length)

  // ABORT CONDITION: any row resolving to a real restaurant must stop the delete.
  const testPattern = nullRid.filter((o) => /^restaurant_test_/.test(String(o.firebase_restaurant_id || '')))
  const notTestPattern = nullRid.filter((o) => !/^restaurant_test_/.test(String(o.firebase_restaurant_id || '')))
  console.log('\nof the NULL rows:')
  console.log('  firebase_restaurant_id matches restaurant_test_%: ' + testPattern.length)
  console.log('  does NOT match:                                   ' + notTestPattern.length)
  if (notTestPattern.length > 0) {
    const sample = {}
    for (const o of notTestPattern) {
      const k = String(o.firebase_restaurant_id ?? 'NULL')
      sample[k] = (sample[k] ?? 0) + 1
    }
    console.log('  *** NON-FIXTURE NULL ROWS PRESENT — these are not in scope: ' + JSON.stringify(sample))
  }

  const byFake = {}
  for (const o of testPattern) {
    const k = String(o.firebase_restaurant_id)
    byFake[k] = (byFake[k] ?? 0) + 1
  }
  console.log('  distribution: ' + JSON.stringify(byFake))

  const dates = testPattern.map((o) => o.placed_at).filter(Boolean).sort()
  if (dates.length) console.log('  date span: ' + String(dates[0]).slice(0, 10) + ' .. ' + String(dates[dates.length - 1]).slice(0, 10))

  // Do any of these fixture rows resolve, via firebase_restaurant_id, to a REAL restaurant?
  const realFirebaseIds = new Set(
    (await all((f, t) => db.from('restaurants').select('firebase_id').range(f, t)))
      .map((r) => r.firebase_id).filter(Boolean),
  )
  const resolvesReal = testPattern.filter((o) => realFirebaseIds.has(o.firebase_restaurant_id))
  console.log('\nABORT CHECK — fixture rows whose firebase id matches a REAL restaurant: ' + resolvesReal.length)

  // ABORT CONDITION: referencing rows, per table.
  const ids = testPattern.map((o) => o.id)
  console.log('\nreferencing rows, per table (' + ids.length + ' order ids):')
  const refCounts = {}
  const countRefs = async (table, column) => {
    let n = 0
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100)
      const { data, error } = await db.from(table).select('id').in(column, slice).limit(1000)
      if (error) { refCounts[table + '.' + column] = 'ERR ' + error.message; return }
      n += (data ?? []).length
    }
    refCounts[table + '.' + column] = n
  }
  for (const [table, column] of [
    ['order_items', 'order_id'],
    ['payments', 'order_id'],
    ['receipts', 'order_id'],
    ['audit_logs', 'entity_id'],
    ['order_requests', 'accepted_order_id'],
    ['stock_movements', 'reference_id'],
  ]) {
    await countRefs(table, column)
  }
  for (const [k, v] of Object.entries(refCounts)) console.log('  ' + k.padEnd(34) + ' ' + v)

  // payment_events.order_ids is an array column — a plain .in() cannot see it.
  try {
    const pe = await all((f, t) => db.from('payment_events').select('id, order_ids').range(f, t))
    const idSet = new Set(ids)
    const touching = pe.filter((e) => Array.isArray(e.order_ids) && e.order_ids.some((x) => idSet.has(x)))
    console.log('  payment_events.order_ids (array)   ' + touching.length + '  of ' + pe.length + ' events scanned')
  } catch (e) {
    console.log('  payment_events.order_ids (array)   ERR ' + e.message)
  }

  // The duplicate-pair count the ruling expects to fall 282 -> 3.
  const seen = new Map()
  for (const o of orders) {
    const k = String(o.restaurant_id ?? 'NULL') + '|' + String(o.order_number ?? '')
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dupPairsAll = [...seen.values()].filter((n) => n > 1).length
  const survivors = orders.filter((o) => !(o.restaurant_id === null && /^restaurant_test_/.test(String(o.firebase_restaurant_id || ''))))
  const seen2 = new Map()
  for (const o of survivors) {
    const k = String(o.restaurant_id ?? 'NULL') + '|' + String(o.order_number ?? '')
    seen2.set(k, (seen2.get(k) ?? 0) + 1)
  }
  const dupPairsAfter = [...seen2.values()].filter((n) => n > 1).length
  console.log('\nduplicate (restaurant_id, order_number) pairs:')
  console.log('  now:            ' + dupPairsAll)
  console.log('  after delete:   ' + dupPairsAfter + '   (ruling expects 282 -> 3)')
}

async function main() {
  const sUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!sUrl || !sKey) throw new Error('no credentials at all')
  await probe(sUrl, sKey)

  if (!sUrl.includes(PRODUCTION_REF)) {
    console.log('\n' + '!'.repeat(78))
    console.log('#324 IS FILED AGAINST PRODUCTION (' + PRODUCTION_REF + ') AND THAT WAS NOT MEASURED.')
    console.log('No env file in this worktree carries a production ref, so the count above is')
    console.log('STAGING and cannot answer any of the ruling\'s abort conditions.')
    console.log('!'.repeat(78))
  }
  console.log('\nPROBE_324_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
