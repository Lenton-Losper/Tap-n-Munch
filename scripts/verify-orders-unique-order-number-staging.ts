/**
 * Staging: prove the #127 unique index is actually ENFORCING, not merely reported as created.
 *
 *   npx tsx scripts/verify-orders-unique-order-number-staging.ts
 *
 * `supabase db query` returning no error only says the statement parsed and ran. This inserts a
 * real duplicate pair and asserts Postgres rejects it with 23505 naming
 * orders_firebase_restaurant_id_order_number_key, then asserts the partial predicate really does
 * exempt NULLs, then deletes every row it created.
 *
 * WRITES to staging: up to four orders rows under a synthetic firebase_restaurant_id that no
 * restaurant uses, at order_number 970001/970002, all deleted in a finally block. Nothing existing
 * is read-modified-written and no real order is touched.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
if (!url.includes(STAGING_REF)) throw new Error(`Refusing: SUPABASE_URL is not staging (${url})`)

const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const INDEX = 'orders_firebase_restaurant_id_order_number_key'
const SCOPE = `verify127-${Date.now()}`
const created: string[] = []

/** A real restaurant uuid is needed for the restaurant_id FK; the index scope stays synthetic. */
const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

async function insertOrder(orderNumber: number | null) {
  const { data, error } = await db
    .from('orders')
    .insert({
      restaurant_id: RESTAURANT_UUID,
      firebase_restaurant_id: SCOPE,
      order_number: orderNumber,
      table_number: 0,
      status: 'pending',
      payment_status: 'unpaid',
      total: 0,
      subtotal: 0,
      items: [],
      is_closed: false,
    })
    .select('id')
    .single()
  if (data?.id) created.push(data.id)
  return { id: data?.id ?? null, error }
}

let failures = 0
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}`)
}

async function main() {
  console.log(`=== #127 unique index enforcement — staging (${STAGING_REF}) ===`)
  console.log(`Synthetic scope: ${SCOPE}\n`)

  const first = await insertOrder(970001)
  check(
    'a first order at (scope, 970001) inserts',
    first.error === null && first.id !== null,
    first.error ? `unexpected error ${first.error.code}: ${first.error.message}` : `id=${first.id}`,
  )

  const duplicate = await insertOrder(970001)
  check(
    'a second order at the SAME (scope, 970001) is rejected',
    duplicate.error?.code === '23505',
    duplicate.error
      ? `${duplicate.error.code}: ${duplicate.error.message}`
      : `NOT REJECTED — the index is not enforcing (inserted id=${duplicate.id})`,
  )
  check(
    'the rejection names the #127 index, not some other unique index',
    `${duplicate.error?.message ?? ''} ${duplicate.error?.details ?? ''}`.includes(INDEX),
    `message=${duplicate.error?.message ?? '(none)'} details=${duplicate.error?.details ?? '(none)'}`,
  )

  const different = await insertOrder(970002)
  check(
    'a different order_number in the same scope still inserts',
    different.error === null && different.id !== null,
    different.error ? `${different.error.code}: ${different.error.message}` : `id=${different.id}`,
  )

  const nullA = await insertOrder(null)
  const nullB = await insertOrder(null)
  check(
    'the partial predicate exempts NULL order_number (staging has 127 such rows)',
    nullA.error === null && nullB.error === null,
    `first=${nullA.error?.message ?? 'ok'} second=${nullB.error?.message ?? 'ok'}`,
  )
}

main()
  .catch((e) => {
    failures++
    console.error('THREW:', e?.message ?? e)
  })
  .finally(async () => {
    for (const id of created) {
      const { error } = await db.from('orders').delete().eq('id', id)
      if (error) console.error(`CLEANUP FAILED for ${id}: ${error.message}`)
    }
    const { count } = await db
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('firebase_restaurant_id', SCOPE)
    console.log(`\nCleanup: deleted ${created.length} row(s); ${count ?? '?'} left under ${SCOPE}.`)
    if (count !== 0) failures++
    console.log(failures === 0 ? '\nRESULT: ALL CHECKS PASSED' : `\nRESULT: ${failures} CHECK(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
