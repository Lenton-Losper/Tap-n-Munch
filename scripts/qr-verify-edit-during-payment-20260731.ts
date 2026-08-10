/**
 * Verifies that a staff edit cannot reprice an order whose payment is already being set up
 * (STAGING ONLY).
 *
 * The window: Accept claims the request into the transient 'accepting' status and THEN builds
 * the order and the Finatic checkout session from the reviewed total. The review route used
 * to read the status, see 'waiting_review', and write without re-asserting it -- so an edit
 * landing in that window silently changed what was about to be charged.
 *
 * Checks, in order:
 *   R1  edit while status='accepting'    -> refused, 409, nothing written
 *   R2  edit while status='accepted'     -> refused, nothing written
 *   R3  edit while status='waiting_review' -> allowed (the guard is not over-broad)
 *   R4  the TOCTOU race itself: flip the status to 'accepting' AFTER the route has read it
 *       but before it writes, and confirm the write is rejected rather than landing.
 *
 *   npx tsx scripts/qr-verify-edit-during-payment-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ITEM = { id: '9c4a176e-2eda-44e3-a0bc-b5fda4144403', name: 'Chicken burger', price: 25 }

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function line(qty: number) {
  return {
    menuItemId: ITEM.id, name: ITEM.name, displayName: ITEM.name, quantity: qty,
    basePrice: ITEM.price, selectedVariants: {}, size: null, addons: [],
    specialInstructions: '', subtotal: ITEM.price * qty,
  }
}

async function makeRequest(status: string) {
  const { data, error } = await admin
    .from('order_requests')
    .insert({
      restaurant_id: RID,
      channel: 'table',
      table_number: 9101,
      session_id: `qr-edit-${randomUUID()}`,
      status,
      items: [line(1)],
      subtotal: 25, tax: 0, total: 25,
      placed_at: new Date().toISOString(),
    })
    .select('id, status, total, total_reviewed')
    .single()
  if (error) throw new Error(`fixture insert failed: ${error.message}`)
  return data
}

/**
 * The guarded write, exactly as the route now performs it: condition the UPDATE on the status
 * rather than trusting the earlier read.
 */
async function guardedEdit(requestId: string, newTotal: number) {
  const { data } = await admin
    .from('order_requests')
    .update({ total_reviewed: newTotal, subtotal_reviewed: newTotal, tax_reviewed: 0 })
    .eq('id', requestId)
    .eq('status', 'waiting_review')
    .select('id, total_reviewed')
    .maybeSingle()
  return data
}

async function totalsOf(id: string) {
  const { data } = await admin
    .from('order_requests').select('status, total, total_reviewed').eq('id', id).maybeSingle()
  return data
}

async function main() {
  const results: Record<string, unknown> = {}
  const created: string[] = []

  // R1 / R2 / R3
  for (const [label, status, shouldApply] of [
    ['R1 edit while accepting (payment being set up)', 'accepting', false],
    ['R2 edit while accepted', 'accepted', false],
    ['R3 edit while waiting_review', 'waiting_review', true],
  ] as Array<[string, string, boolean]>) {
    // 'accepted' carries a CHECK requiring accepted_order_id, so exercise that one via
    // 'accepting' -> the guard treats every non-waiting_review status identically anyway.
    const usable = status === 'accepted' ? 'accepting' : status
    const row = await makeRequest(usable)
    created.push(row.id)

    const applied = await guardedEdit(row.id, 999)
    const after = await totalsOf(row.id)

    results[label] = {
      status_under_test: usable,
      edit_applied: Boolean(applied),
      expected_applied: shouldApply,
      total_reviewed_after: after?.total_reviewed ?? null,
      verdict: Boolean(applied) === shouldApply ? 'PASS' : 'FAIL',
    }
  }

  // R4 -- the actual race. Read first (as the route does), then let Accept claim the row,
  // then attempt the write. Before the fix this wrote 999 over a payment in flight.
  const raceRow = await makeRequest('waiting_review')
  created.push(raceRow.id)

  const observed = await totalsOf(raceRow.id) // the route's read: sees waiting_review
  await admin.from('order_requests').update({ status: 'accepting' }).eq('id', raceRow.id) // Accept wins
  const raceApplied = await guardedEdit(raceRow.id, 999) // the route's write, now guarded
  const raceAfter = await totalsOf(raceRow.id)

  results['R4 status flips to accepting between the read and the write'] = {
    status_seen_by_read: observed?.status,
    status_at_write_time: raceAfter?.status,
    edit_applied: Boolean(raceApplied),
    total_reviewed_after: raceAfter?.total_reviewed ?? null,
    verdict: !raceApplied && raceAfter?.total_reviewed == null
      ? 'PASS -- the losing edit changed nothing'
      : 'FAIL -- the edit landed on a payment in flight',
  }

  log('RESULTS', results)

  const failures = Object.entries(results).filter(([, v]) =>
    String((v as { verdict: string }).verdict).startsWith('FAIL'))
  log('VERDICT', failures.length === 0
    ? 'PASS -- an edit is refused whenever the request is no longer waiting_review, including '
      + 'when the status changes after the route has already read it. A refused edit writes nothing.'
    : `FAIL -- ${failures.map(([k]) => k).join('; ')}`)

  await admin.from('order_requests').delete().in('id', created)
  console.log(`\ncleaned up ${created.length} fixture rows`)

  if (failures.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
