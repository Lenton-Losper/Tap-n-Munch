/**
 * #121 — is the cash "Ready to Pay" button actually dead?
 *
 * `components/ready-to-pay-cash.tsx` writes direct-to-DB with the BROWSER ANON client:
 *
 *     await supabase.from('orders').update({ customer_ready_to_pay: true })
 *
 * The issue says the anon UPDATE policy is `WITH CHECK (status = 'ready_for_terminal')`, evaluated
 * against the RESULTING row — so a cash order still sitting at accepted/preparing/ready is
 * rejected 42501, and the customer sees a permanent failure while staff are never notified.
 *
 * That file is UNCHANGED at the production ref, so if the claim holds the button is still dead.
 * This tests it with the ANON key, which is what the browser uses — using the service-role key
 * would bypass RLS entirely and manufacture a pass.
 *
 * TWO-SIDED, and the second half is what makes it meaningful:
 *
 *   an order NOT at ready_for_terminal  -> expected 42501   (the defect)
 *   an order AT ready_for_terminal      -> expected success (the control)
 *
 * Without the control, a refusal could equally be RLS being off, the column missing, or the anon
 * key being wrong — none of which is this defect.
 *
 * Staging only, self-cleaning.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url || '(unset)'} is not staging`)
if (!anon) throw new Error('GUARD: no anon key — this probe is meaningless without it')

const admin = createClient(url, service, { auth: { persistSession: false } })
const browser = createClient(url, anon, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

async function seed(status: string) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      restaurant_id: RID,
      table_number: 0,
      channel: 'table',
      status,
      payment_status: 'cash_pending',
      payment_method: 'cash',
      items: [],
      subtotal: 0,
      tax: 0,
      total: 0,
      placed_at: new Date().toISOString(),
      session_id: `probe121-${randomUUID()}`,
    })
    .select('id, status')
    .single()
  if (error) throw new Error(`seed ${status}: ${error.message}`)
  return data
}

async function pressReadyToPay(orderId: string) {
  // EXACTLY what components/ready-to-pay-cash.tsx does.
  const { error } = await browser
    .from('orders')
    .update({ customer_ready_to_pay: true })
    .eq('id', orderId)
  return { ok: !error, code: error?.code ?? null, message: error?.message ?? null }
}

async function main() {
  console.log('\nSTAGING — #121: does the cash Ready to Pay button work, pressed as the browser?\n')

  const ids: string[] = []
  try {
    // ---- the defect: a cash order at a normal kitchen status
    const cashOrder = await seed('accepted')
    ids.push(cashOrder.id)
    const defect = await pressReadyToPay(cashOrder.id)
    console.log(`  order at status='accepted'          -> ${defect.ok ? 'ACCEPTED' : `REFUSED ${defect.code}`}`)
    if (!defect.ok) console.log(`      ${String(defect.message).slice(0, 110)}`)

    // ---- the control: an order the policy is written for
    const terminalOrder = await seed('ready_for_terminal')
    ids.push(terminalOrder.id)
    const control = await pressReadyToPay(terminalOrder.id)
    console.log(`  order at status='ready_for_terminal' -> ${control.ok ? 'ACCEPTED' : `REFUSED ${control.code}`}`)
    if (!control.ok) console.log(`      ${String(control.message).slice(0, 110)}`)

    // ---- did the write actually land? An "ok" from PostgREST with RLS can update ZERO rows.
    const { data: after } = await admin
      .from('orders')
      .select('id, customer_ready_to_pay')
      .in('id', ids)
    const flagById = new Map((after ?? []).map((r) => [String(r.id), r.customer_ready_to_pay]))
    console.log('\n  DID THE FLAG ACTUALLY CHANGE?')
    console.log(`      accepted order          customer_ready_to_pay = ${flagById.get(cashOrder.id)}`)
    console.log(`      ready_for_terminal order customer_ready_to_pay = ${flagById.get(terminalOrder.id)}`)

    const defectReproduced = flagById.get(cashOrder.id) !== true
    const controlWorked = flagById.get(terminalOrder.id) === true

    console.log('')
    if (defectReproduced && controlWorked) {
      console.log('  #121 REPRODUCED — the cash button cannot set the flag, while the policy path can.')
    } else if (defectReproduced && !controlWorked) {
      console.log('  INCONCLUSIVE — neither path wrote. The control failing means this is not')
      console.log('  evidence about the cash case specifically: RLS may block anon UPDATE entirely.')
    } else if (!defectReproduced) {
      console.log('  NOT REPRODUCED — the cash order WAS updated. #121 does not hold on staging as written.')
    }

    console.log('\n  NOTE: a silent zero-row UPDATE is why the flag is re-read rather than trusting')
    console.log('  the absence of an error. PostgREST reports no error when RLS filters every row.')
  } finally {
    for (const id of ids) await admin.from('orders').delete().eq('id', id)
    console.log('  cleaned')
  }
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
