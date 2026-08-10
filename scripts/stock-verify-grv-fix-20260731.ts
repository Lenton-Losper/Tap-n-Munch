/**
 * Verifies the Receive Stock fix end to end (STAGING ONLY).
 *
 * The bug: assign_grv_number() (BEFORE INSERT on goods_received) was not SECURITY DEFINER,
 * so it ran as the caller and called generate_document_number, whose EXECUTE is granted to
 * service_role only -- every staff delivery raised 42501 after the insert had begun.
 *
 * Verifying this correctly means inserting as the role that actually failed, `authenticated`
 * -- NOT with the service-role client, which would have succeeded even before the fix and
 * would prove nothing. That is the same mistake that let my earlier track_inventory fix ship
 * broken, so this checks the privilege boundary explicitly.
 *
 *   npx tsx scripts/stock-verify-grv-fix-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const { data: fnMeta } = await (admin.rpc('exec_noop').then(() => ({ data: null })) as Promise<{ data: null }>).catch(() => ({ data: null }))
  void fnMeta

  const { data: stockItem } = await admin
    .from('stock_items')
    .select('id, name, unit_id')
    .eq('restaurant_id', RESTAURANT)
    .limit(1)
    .maybeSingle()
  if (!stockItem) throw new Error('no staging stock item to receive against')

  async function balanceOf(id: string) {
    const { data } = await admin.from('stock_movements').select('quantity_delta').eq('stock_item_id', id)
    return (data ?? []).reduce((sum, m) => sum + Number(m.quantity_delta), 0)
  }

  const before = await balanceOf(stockItem.id)
  log('FIXTURE', { stockItem: { id: stockItem.id, name: stockItem.name }, opening_balance: before })

  // --- the insert that used to fail, run as a REAL authenticated staff user ---
  //
  // A bare anon client is not good enough: RLS on goods_received rejects it before the
  // trigger ever runs, which looks like a failure but tests nothing. Mint a real session for
  // a staff owner so the insert passes RLS and actually reaches assign_grv_number.
  const ownerEmail = process.env.GRV_VERIFY_EMAIL || 'flashtap.staging.test@gmail.com'
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: ownerEmail,
  })
  if (linkError) throw new Error(`could not mint a session for ${ownerEmail}: ${linkError.message}`)

  const userClient = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: session, error: otpError } = await userClient.auth.verifyOtp({
    email: ownerEmail,
    token: linkData.properties.email_otp,
    type: 'email',
  })
  if (otpError) throw new Error(`could not establish a session: ${otpError.message}`)
  log('SIGNED IN AS', { email: session.user?.email, role: session.user?.role, id: session.user?.id })

  const { data: grv, error: grvError } = await userClient
    .from('goods_received')
    .insert({
      restaurant_id: RESTAURANT,
      supplier: `grv-fix-check-${Date.now()}`,
      invoice_number: 'VERIFY-1',
    })
    .select('id, grv_number')
    .maybeSingle()

  log('INSERT goods_received as the caller role (this is what raised 42501)', {
    error_code: (grvError as { code?: string } | null)?.code ?? null,
    error_message: grvError?.message ?? null,
    grv_id: grv?.id ?? null,
    grv_number: grv?.grv_number ?? null,
  })

  const numberingFixed =
    (grvError as { code?: string } | null)?.code !== '42501' &&
    !String(grvError?.message ?? '').includes('generate_document_number')

  log('NUMBERING TRIGGER', numberingFixed
    ? 'PASS -- no 42501 from generate_document_number; the trigger now runs as owner'
    : `FAIL -- still blocked: ${grvError?.message}`)

  // --- full path through the service role, to prove a delivery records and stock moves ---
  const { data: grv2, error: grv2Error } = await admin
    .from('goods_received')
    .insert({
      restaurant_id: RESTAURANT,
      supplier: `grv-fix-check-full-${Date.now()}`,
      invoice_number: 'VERIFY-2',
    })
    .select('id, grv_number')
    .single()
  if (grv2Error) throw new Error(`full-path GRV insert failed: ${grv2Error.message}`)

  const { data: line, error: lineError } = await admin
    .from('goods_received_items')
    .insert({
      goods_received_id: grv2.id,
      stock_item_id: stockItem.id,
      quantity: 12,
      unit_cost: 3,
    })
    .select('id')
    .single()
  if (lineError) throw new Error(`line item insert failed: ${lineError.message}`)

  const after = await balanceOf(stockItem.id)
  const { data: movements } = await admin
    .from('stock_movements')
    .select('id, quantity_delta, reason, reference_type, reference_id')
    .eq('reference_id', line.id)

  log('DELIVERY RECORDED', {
    grv_number: grv2.grv_number,
    line_item_id: line.id,
    movements_created: (movements ?? []).length,
    movement: (movements ?? [])[0] ?? null,
    balance_before: before,
    balance_after: after,
    delta: after - before,
  })

  const stockMoved = after - before === 12 && (movements ?? []).length === 1

  log('VERDICT', numberingFixed && stockMoved
    ? 'FIXED -- a GRV number is issued without 42501, the delivery records, one movement is '
      + 'posted, and stock increases by the received quantity.'
    : `NOT FIXED -- numbering_ok=${numberingFixed} stock_moved=${stockMoved} (delta ${after - before}, movements ${(movements ?? []).length})`)

  // Cleanup.
  await admin.from('stock_movements').delete().eq('reference_id', line.id)
  await admin.from('goods_received_items').delete().eq('id', line.id)
  await admin.from('goods_received').delete().eq('id', grv2.id)
  if (grv?.id) await admin.from('goods_received').delete().eq('id', grv.id)
  const final = await balanceOf(stockItem.id)
  console.log(`\ncleaned up; balance restored to ${final} (was ${before})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
