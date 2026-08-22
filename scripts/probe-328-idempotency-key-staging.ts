/**
 * #328 — two-sided HTTP probe against the deployed STAGING Worker.
 *
 * The claim under test: the terminal sending `x-idempotency-key` makes a retry of the same sale
 * return the order that already exists, instead of stranding it and creating another.
 *
 * The server half has existed for a long time (app/api/terminal/orders/route.ts reads the header,
 * lib/orders/create-order.ts stores it and treats 23505 as "already exists"). What was missing is a
 * client that sends it — measured on production, all time: 0 of 1545 POS orders carried a key. So
 * this proves the CONTRACT works when honoured, which is what the terminal change relies on.
 *
 * BOTH DIRECTIONS, because either alone is meaningless:
 *   SAME key twice      -> exactly ONE order
 *   DIFFERENT keys      -> exactly TWO orders
 *
 * AND TWO CONTROLS, because "one order" and "no order at all" look identical from a response body:
 *   - a plain create must actually produce a row (the route works)
 *   - NO key at all, twice, must produce TWO rows (the dedup comes from the key, not from some
 *     unrelated guard that would collapse any two identical carts)
 *
 * Counted in the DATABASE, not from the response, because a route could return the same id twice
 * while still writing two rows.
 *
 * Marker: PROBE_328_IDEMPOTENCY_STAGING_OK
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-328-idempotency-key-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'
import { generateTerminalActivationCode } from '../lib/terminals/activation-code'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const WORKER = process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.STAGING_SUPABASE_URL || process.env.SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function main() {
  assert(url.includes(STAGING_REF), `REFUSING: not staging — ${url}`)
  assert(serviceKey, 'Need the staging service role key')
  console.log(`worker   ${WORKER}\nsupabase ${url}\n`)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const tag = `probe-328-${Date.now()}`
  const activationCode = generateTerminalActivationCode()

  // Self-healing: an earlier run that died during SETUP left its rows behind, because the
  // cleanup only covered the body. Sweep them before starting so the leak cannot accumulate.
  const { data: stale } = await admin.from('restaurants').select('id').like('name', 'probe-328-%')
  for (const r of stale ?? []) {
    const rid = String((r as { id: string }).id)
    const { data: old } = await admin.from('orders').select('id').eq('restaurant_id', rid)
    const oldIds = (old ?? []).map((o: { id: string }) => String(o.id))
    if (oldIds.length) {
      await admin.from('audit_logs').delete().in('entity_id', oldIds)
      await admin.from('orders').delete().in('id', oldIds)
    }
    await admin.from('restaurant_terminals').delete().eq('restaurant_id', rid)
    await admin.from('menu_items').delete().eq('restaurant_id', rid)
    await admin.from('restaurants').delete().eq('id', rid)
    console.log(`swept a leftover probe restaurant: ${rid}`)
  }

  let restaurantId = ''
  let menuItemId = ''
  let terminalId = ''
  let failures = 0
  // Setup lives INSIDE the try so a failure here still reaches cleanup.
  try {

  const { data: restaurant, error: rErr } = await admin
    .from('restaurants')
    .insert({ name: tag, finatic_merchant_no: 'STAGING_STUB_MERCHANT', finatic_store_no: 'STAGING_STUB_STORE' })
    .select('id')
    .single()
  assert(!rErr && restaurant?.id, `restaurant insert failed: ${rErr?.message}`)
  restaurantId = String(restaurant.id)

  const { data: menuItem, error: mErr } = await admin
    .from('menu_items')
    .insert({ restaurant_id: restaurantId, name: `${tag}-coffee`, base_price: 25, status: 'available' })
    .select('id')
    .single()
  assert(!mErr && menuItem?.id, `menu item insert failed: ${mErr?.message}`)
  menuItemId = String(menuItem.id)

  const { data: terminal, error: tErr } = await admin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: restaurantId,
      terminal_name: tag,
      active: false,
      status: 'pending',
      activation_code: activationCode,
      activation_code_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      device_id: `pending-${randomUUID()}`,
    })
    .select('id')
    .single()
  assert(!tErr && terminal?.id, `terminal insert failed: ${tErr?.message}`)
  terminalId = String(terminal.id)

    const act = await fetch(`${WORKER}/api/terminals/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: activationCode, deviceId: tag, terminalSn: tag }),
    })
    const actJson = await act.json()
    assert(act.status === 200 && actJson?.accessToken, `activate failed: ${act.status}`)
    const token = String(actJson.accessToken)

    const create = (key: string | null) =>
      fetch(`${WORKER}/api/terminal/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(key ? { 'x-idempotency-key': key } : {}),
        },
        body: JSON.stringify({
          restaurantId,
          items: [{ menuItemId, name: `${tag}-coffee`, quantity: 1, basePrice: 25, subtotal: 25 }],
          subtotal: 25,
          total: 25,
        }),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

    /** Counts rows in the DB, paginated. The response body is not evidence about what was written. */
    const countByKey = async (key: string) => {
      const rows: unknown[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin
          .from('orders')
          .select('id')
          .eq('restaurant_id', restaurantId)
          .eq('idempotency_key', key)
          .range(from, from + 999)
        assert(!error, `count query failed: ${error?.message}`)
        rows.push(...(data ?? []))
        if (!data || data.length < 1000) break
      }
      return rows.length
    }
    const countAll = async () => {
      const rows: unknown[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin
          .from('orders')
          .select('id')
          .eq('restaurant_id', restaurantId)
          .range(from, from + 999)
        assert(!error, `count query failed: ${error?.message}`)
        rows.push(...(data ?? []))
        if (!data || data.length < 1000) break
      }
      return rows.length
    }

    const check = (label: string, ok: boolean, detail: string) => {
      if (!ok) failures++
      console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}  ${detail}`)
    }

    // ---------------------------------------------------------------- control 1: the route works
    console.log('CONTROL 1 — a plain create actually writes a row')
    const ctrlKey = `${tag}-control`
    const ctrl = await create(ctrlKey)
    check('create returns 2xx', ctrl.status >= 200 && ctrl.status < 300, `status=${ctrl.status}`)
    check('exactly one row written', (await countByKey(ctrlKey)) === 1, `rows=${await countByKey(ctrlKey)}`)

    // ---------------------------------------------------------------- side A: same key, concurrent
    console.log('\nSIDE A — SAME key twice, fired concurrently')
    const keyA = `${tag}-same`
    const [a1, a2] = await Promise.all([create(keyA), create(keyA)])
    const rowsA = await countByKey(keyA)
    check('both requests answered 2xx', a1.status < 300 && a2.status < 300, `${a1.status} / ${a2.status}`)
    check('EXACTLY ONE order exists', rowsA === 1, `rows=${rowsA}`)
    check(
      'both responses name the same order',
      Boolean(a1.body?.orderId) && a1.body?.orderId === a2.body?.orderId,
      `${a1.body?.orderId} vs ${a2.body?.orderId}`,
    )

    // ---------------------------------------------------------------- side A': same key, sequential
    console.log("\nSIDE A' — SAME key twice, one after the other (the real retry shape)")
    const keyA2 = `${tag}-same-seq`
    const s1 = await create(keyA2)
    const s2 = await create(keyA2)
    const rowsA2 = await countByKey(keyA2)
    check('EXACTLY ONE order exists', rowsA2 === 1, `rows=${rowsA2}`)
    check(
      'the retry is answered with the original order',
      Boolean(s1.body?.orderId) && s1.body?.orderId === s2.body?.orderId,
      `${s1.body?.orderId} vs ${s2.body?.orderId}`,
    )

    // ---------------------------------------------------------------- side B: different keys
    console.log('\nSIDE B — DIFFERENT keys must still create two orders')
    const keyB1 = `${tag}-diff-1`
    const keyB2 = `${tag}-diff-2`
    const b1 = await create(keyB1)
    const b2 = await create(keyB2)
    const rowsB = (await countByKey(keyB1)) + (await countByKey(keyB2))
    check('TWO orders exist', rowsB === 2, `rows=${rowsB}`)
    check(
      'they are different orders',
      Boolean(b1.body?.orderId) && b1.body?.orderId !== b2.body?.orderId,
      `${b1.body?.orderId} vs ${b2.body?.orderId}`,
    )

    // ------------------------------------------------- control 2: dedup comes FROM the key
    console.log('\nCONTROL 2 — NO key at all, twice: must create TWO (today\'s production behaviour)')
    const before = await countAll()
    await create(null)
    await create(null)
    const after = await countAll()
    check('two identical keyless carts create two orders', after - before === 2, `delta=${after - before}`)

    console.log(
      failures === 0
        ? '\nPROBE_328_IDEMPOTENCY_STAGING_OK'
        : `\n*** ${failures} CHECK(S) FAILED — do not ship the terminal half on this evidence ***`,
    )
  } finally {
    const { data: mine } = restaurantId
      ? await admin.from('orders').select('id').eq('restaurant_id', restaurantId)
      : { data: [] }
    const ids = (mine ?? []).map((o: { id: string }) => String(o.id))
    if (ids.length) {
      await admin.from('audit_logs').delete().in('entity_id', ids)
      await admin.from('orders').delete().in('id', ids)
    }
    if (terminalId) await admin.from('restaurant_terminals').delete().eq('id', terminalId)
    if (menuItemId) await admin.from('menu_items').delete().eq('id', menuItemId)
    if (restaurantId) await admin.from('restaurants').delete().eq('id', restaurantId)
    console.log(`\ncleaned up: ${ids.length} order(s), terminal, menu item, restaurant`)
  }
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
