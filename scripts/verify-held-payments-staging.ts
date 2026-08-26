/**
 * #344 RULING 3 — the two-sided property, proven against the DEPLOYED staging worker.
 *
 * ============================================================================================
 * WHY THIS EXISTS WHEN THERE ARE ALREADY 24 UNIT TESTS
 * ============================================================================================
 *
 * Because those tests cannot see the thing the property actually rests on.
 *
 * Mutating the route to DISABLE the read-first branch entirely -- so it never returns an existing
 * receiptId and always attempts an insert -- leaves all 24 green. That is not a hole in the suite;
 * it is the design becoming visible. Without the read, the insert violates the unique index, the
 * route takes the 23505 branch, re-reads, and returns the stored id. Identical behaviour.
 *
 * SO THE GUARANTEE IS `held_payments_idempotency_unique`, NOT THE READ. And the unit tests enforce
 * uniqueness in a mock that was written to enforce it, which is exactly the way a mock lies. If
 * that constraint is missing from a database, a re-POST writes a SECOND ROW and issues a SECOND
 * receiptId, and nothing in jest would notice.
 *
 * This script POSTs the same record twice through the real worker at the real database and counts
 * rows. It is the only place the constraint is actually checked.
 *
 * ============================================================================================
 * WHAT EACH ASSERTION IS FOR
 * ============================================================================================
 *
 * The dangerous failure is a 2xx carrying `stored: true` when nothing was written, because that is
 * what deletes the device's only copy of a card transaction. So:
 *
 *   1. FIRST POST     stores exactly one row and returns a receiptId. The POSITIVE CONTROL --
 *                     without it, every assertion below is satisfied by an endpoint that stores
 *                     nothing at all and always 500s.
 *   2. RE-POST        returns the SAME receiptId, and the table STILL holds one row. Row-counted
 *                     in the database, not inferred from the response.
 *   3. DIFFERENT heldAt is a different record and DOES get its own row. The negative control on
 *                     (2): an endpoint that deduplicated on businessOrderNo alone, or that never
 *                     inserted twice for any input, would pass (2) and fail here.
 *   4. CASE 3         a record naming no order at all is stored. This is the record
 *                     verify-payment can never resolve and the whole reason ruling 1 replaced
 *                     reconciliation with a durable write.
 *   5. NO AUTH        is refused, and writes nothing.
 *
 * Marker: VERIFY_HELD_PAYMENTS_STAGING_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'
import { generateTerminalActivationCode } from '../lib/terminals/activation-code'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

let failures = 0
const check = (label: string, ok: unknown, detail = '') => {
  if (!ok) failures++
  console.log('  ' + (ok ? 'PASS  ' : '*** FAIL ***  ') + label + (detail ? '   ' + detail : ''))
}
const log = (label: string, value: unknown) => {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function httpJson(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json: json as any, text }
}

async function main() {
  if (!url.includes(STAGING_REF) || !serviceKey) {
    throw new Error('REFUSING: need a STAGING supabase URL + service role key — got ' + url)
  }
  log('worker', WORKER)
  log('supabase', url)

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `held-payments-${Date.now()}`
  const activationCode = generateTerminalActivationCode()
  const deviceSerial = `probe-${tag}`

  const { data: restaurant, error: restaurantErr } = await admin
    .from('restaurants')
    .insert({
      name: tag,
      finatic_merchant_no: 'STAGING_STUB_MERCHANT',
      finatic_store_no: 'STAGING_STUB_STORE',
    })
    .select('id')
    .single()
  if (restaurantErr || !restaurant?.id) throw new Error(`restaurant insert: ${restaurantErr?.message}`)
  const restaurantId = String(restaurant.id)

  const { data: terminal, error: termErr } = await admin
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
  if (termErr || !terminal?.id) throw new Error(`terminal insert: ${termErr?.message}`)
  const terminalId = String(terminal.id)

  const countRows = async (idempotencyKey?: string) => {
    let q = admin.from('held_payments').select('id, receipt_id, idempotency_key').eq('restaurant_id', restaurantId)
    if (idempotencyKey) q = q.eq('idempotency_key', idempotencyKey)
    const { data, error } = await q
    if (error) throw new Error(`held_payments read: ${error.message}`)
    return data ?? []
  }

  try {
    const activate = await httpJson('POST', '/api/terminals/activate', {
      code: activationCode,
      deviceId: deviceSerial,
      terminalSn: deviceSerial,
    })
    if (activate.status !== 200) throw new Error(`activate failed: ${activate.status} ${activate.text}`)
    const accessToken = String(activate.json?.accessToken || '')
    if (!accessToken) throw new Error('activate returned no accessToken')
    const auth = { Authorization: `Bearer ${accessToken}` }

    const businessOrderNo = `FTHP${Date.now()}`.slice(0, 32)
    const heldAt = new Date().toISOString()
    const key = `${businessOrderNo.length}|${businessOrderNo}|${heldAt}`
    const record = {
      idempotencyKey: key,
      businessOrderNo,
      voucherNo: 'V-PROBE-1',
      heldAt,
      orphanOrderId: 'order-that-does-not-resolve',
      seenWhileChargingOrderId: 'order-on-screen',
      reason: 'different_order',
      outcomeKind: 'orphaned_success',
    }

    // ---------------------------------------------------------------- 1. first POST
    console.log('\n1. FIRST POST — stores one row and issues a receiptId')
    const first = await httpJson('POST', '/api/terminal/held-payments', record, auth)
    log('FIRST', first)
    check('status 200', first.status === 200, `got ${first.status}`)
    check('stored is true', first.json?.stored === true)
    check('receiptId looks like HP-XXXXXXXX', /^HP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(String(first.json?.receiptId ?? '')), String(first.json?.receiptId))
    check(
      'response carries EXACTLY stored + receiptId (ruling 4)',
      JSON.stringify(Object.keys(first.json ?? {}).sort()) === JSON.stringify(['receiptId', 'stored']),
      Object.keys(first.json ?? {}).join(','),
    )
    const afterFirst = await countRows(key)
    check('the row is IN THE DATABASE — the positive control', afterFirst.length === 1, `${afterFirst.length} row(s)`)

    // ---------------------------------------------------------------- 2. re-POST
    console.log('\n2. RE-POST of the same record — same receiptId, still one row')
    const second = await httpJson('POST', '/api/terminal/held-payments', record, auth)
    log('SECOND', second)
    check('status 200 or 409 — both are acknowledgements', second.status === 200 || second.status === 409, `got ${second.status}`)
    if (second.status === 200) {
      check('the SAME receiptId', second.json?.receiptId === first.json?.receiptId, `${first.json?.receiptId} vs ${second.json?.receiptId}`)
    }
    const afterSecond = await countRows(key)
    check(
      'STILL exactly one row — this is what held_payments_idempotency_unique buys',
      afterSecond.length === 1,
      `${afterSecond.length} row(s) — if this is 2, the unique constraint is missing on this database`,
    )

    // ---------------------------------------------------------------- 3. negative control
    console.log('\n3. NEGATIVE CONTROL — a different heldAt IS a different record')
    const heldAt2 = new Date(Date.now() + 1000).toISOString()
    const key2 = `${businessOrderNo.length}|${businessOrderNo}|${heldAt2}`
    const third = await httpJson('POST', '/api/terminal/held-payments', { ...record, idempotencyKey: key2, heldAt: heldAt2 }, auth)
    check('status 200', third.status === 200, `got ${third.status}`)
    check('a DIFFERENT receiptId', third.json?.receiptId !== first.json?.receiptId)
    const afterThird = await countRows()
    check(
      'now two rows — so (2) is not passing because nothing ever inserts twice',
      afterThird.length === 2,
      `${afterThird.length} row(s)`,
    )

    // ---------------------------------------------------------------- 4. case 3
    console.log('\n4. CASE 3 — a record naming no order at all is still stored')
    const heldAt3 = new Date(Date.now() + 2000).toISOString()
    const key3 = `0||${heldAt3}`
    const case3 = await httpJson(
      'POST',
      '/api/terminal/held-payments',
      { idempotencyKey: key3, heldAt: heldAt3, reason: 'unknown_order', voucherNo: 'V-PROBE-3' },
      auth,
    )
    log('CASE3', case3)
    check('status 200 — no order, no merchant no, still accepted', case3.status === 200, `got ${case3.status}`)
    const case3Rows = await countRows(key3)
    check('stored', case3Rows.length === 1, `${case3Rows.length} row(s)`)

    // ---------------------------------------------------------------- 5. no auth
    console.log('\n5. NO AUTH — refused, and nothing written')
    const before = (await countRows()).length
    const noAuth = await httpJson('POST', '/api/terminal/held-payments', {
      ...record,
      idempotencyKey: `noauth|${Date.now()}`,
      heldAt: new Date().toISOString(),
    })
    check('401 without a token', noAuth.status === 401, `got ${noAuth.status}`)
    check('never answers stored:true', noAuth.json?.stored !== true)
    check('wrote nothing', (await countRows()).length === before)

    console.log('')
    if (failures > 0) {
      console.log(`*** ${failures} ASSERTION(S) FAILED ***`)
      process.exitCode = 1
    } else {
      console.log('VERIFY_HELD_PAYMENTS_STAGING_OK')
    }
  } finally {
    await admin.from('held_payments').delete().eq('restaurant_id', restaurantId)
    await admin.from('restaurant_terminals').delete().eq('id', terminalId)
    await admin.from('restaurants').delete().eq('id', restaurantId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
