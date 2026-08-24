/**
 * #335 — PROVE THE STOCK ACTUALLY COMES BACK. Staging only.
 *
 * The defect was that a dispatched transfer had no way out: cancel accepted DRAFT only and there
 * was no reject, so stock deducted at dispatch could sit IN_TRANSIT forever with the goods on
 * nobody's books. A migration that merely APPLIES proves none of that — the only evidence that
 * counts is a balance going down at dispatch and back up at reject.
 *
 * Every assertion is a measured stock balance, computed the same way dispatch_transfer computes
 * availability: SUM(quantity_delta) over stock_movements.
 *
 * Marker: VERIFY_335_TRANSFER_REJECT_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: not staging — ${url}`)

const db = createClient(url, key, { auth: { persistSession: false } })
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}${detail ? '  ' + detail : ''}`)
}

/** Same arithmetic dispatch_transfer uses to decide availability. */
async function balance(restaurantId: string, stockItemId: string): Promise<number> {
  let total = 0
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('stock_movements')
      .select('quantity_delta')
      .eq('restaurant_id', restaurantId)
      .eq('stock_item_id', stockItemId)
      .range(from, from + 999)
    if (error) throw new Error(`balance: ${error.message}`)
    for (const r of data ?? []) total += Number((r as { quantity_delta: number }).quantity_delta)
    if (!data || data.length < 1000) break
  }
  return total
}

async function main() {
  const tag = `v335-${Date.now()}`
  console.log(`staging ${url}\nseed ${tag}\n`)

  let orgId = '', srcId = '', dstId = '', userId = '', osiId = '', unitId = ''
  const stockItemIds: string[] = []

  try {
    // ---------------------------------------------------------------- seed
    // organizations.owner_user_id is NOT NULL, so an owner has to exist before the org does.
    const { data: u0, error: uErr } = await db.from('users').select('id').limit(1).single()
    if (uErr) throw new Error(`no user to own the org: ${uErr.message}`)
    userId = String(u0.id)
    const { data: org, error: oErr } = await db.from('organizations')
      .insert({ name: tag, owner_user_id: userId }).select('id').single()
    if (oErr) throw new Error(`organizations: ${oErr.message}`)
    orgId = String(org.id)
    const mk = async (n: string) => {
      const { data, error } = await db.from('restaurants')
        .insert({ name: n, organization_id: orgId, finatic_merchant_no: 'S', finatic_store_no: 'S' })
        .select('id').single()
      if (error) throw new Error(`restaurant ${n}: ${error.message}`)
      return String(data.id)
    }
    srcId = await mk(`${tag}-source`)
    dstId = await mk(`${tag}-dest`)

    const { data: unit, error: unErr } = await db.from('measurement_units').select('id').limit(1).single()
    if (unErr) throw new Error(`measurement_units: ${unErr.message}`)
    unitId = String(unit.id)

    const { data: osi, error: osiErr } = await db.from('organization_stock_items')
      .insert({ organization_id: orgId, name: `${tag}-beans`, base_unit_id: unitId })
      .select('id').single()
    if (osiErr) throw new Error(`organization_stock_items: ${osiErr.message}`)
    osiId = String(osi.id)

    const mkItem = async (rid: string) => {
      const { data, error } = await db.from('stock_items')
        .insert({ restaurant_id: rid, name: `${tag}-beans`, unit_id: unitId, organization_stock_item_id: osiId, is_active: true })
        .select('id').single()
      if (error) throw new Error(`stock_items at ${rid}: ${error.message}`)
      stockItemIds.push(String(data.id))
      return String(data.id)
    }
    const srcItem = await mkItem(srcId)
    await mkItem(dstId)

    // Opening stock at the source, so there is something to send.
    await db.from('stock_movements').insert({
      restaurant_id: srcId, stock_item_id: srcItem, quantity_delta: 20, reason: 'received',
    })

    const opening = await balance(srcId, srcItem)
    check('opening balance at source is 20', opening === 20, `got ${opening}`)

    // ---------------------------------------------------------------- REJECT
    console.log('\nREJECT — a destination refusing must give the stock back')
    const { data: t1, error: e1 } = await db.rpc('create_transfer', {
      p_organization_id: orgId, p_from_restaurant_id: srcId, p_to_restaurant_id: dstId,
      p_user_id: userId, p_items: [{ organization_stock_item_id: osiId, quantity_sent: 5, unit_id: unitId }],
    })
    if (e1) throw new Error(`create_transfer: ${e1.message}`)
    const transfer1 = String(t1)

    const { error: dErr } = await db.rpc('dispatch_transfer', { p_transfer_id: transfer1, p_user_id: userId })
    if (dErr) throw new Error(`dispatch: ${dErr.message}`)
    const afterDispatch = await balance(srcId, srcItem)
    check('dispatch DEDUCTS from source', afterDispatch === 15, `20 -> ${afterDispatch}`)

    const { error: rErr } = await db.rpc('reject_transfer', {
      p_transfer_id: transfer1, p_user_id: userId, p_reason: 'wrong item',
    })
    check('reject succeeds', !rErr, rErr?.message ?? '')
    const afterReject = await balance(srcId, srcItem)
    check('reject RETURNS the stock to source', afterReject === 20, `15 -> ${afterReject}`)

    const { data: t1row } = await db.from('stock_transfers')
      .select('status, rejection_reason, rejected_by').eq('id', transfer1).single()
    check('status is REJECTED', (t1row as any)?.status === 'REJECTED', String((t1row as any)?.status))
    check('the reason is recorded', (t1row as any)?.rejection_reason === 'wrong item')

    const { data: mv } = await db.from('stock_movements')
      .select('reason, quantity_delta, reference_id').eq('reference_id', transfer1)
    const reasons = (mv ?? []).map((m: any) => m.reason).sort()
    check('the ledger tells the whole story', JSON.stringify(reasons) === '["transfer_out","transfer_return"]', reasons.join(','))

    // ---------------------------------------------------------------- CANCEL IN TRANSIT
    console.log('\nCANCEL IN TRANSIT — a sender recalling their own goods')
    const { data: t2 } = await db.rpc('create_transfer', {
      p_organization_id: orgId, p_from_restaurant_id: srcId, p_to_restaurant_id: dstId,
      p_user_id: userId, p_items: [{ organization_stock_item_id: osiId, quantity_sent: 7, unit_id: unitId }],
    })
    const transfer2 = String(t2)
    await db.rpc('dispatch_transfer', { p_transfer_id: transfer2, p_user_id: userId })
    const afterDispatch2 = await balance(srcId, srcItem)
    check('dispatch DEDUCTS again', afterDispatch2 === 13, `20 -> ${afterDispatch2}`)

    const { error: cErr } = await db.rpc('cancel_transfer', { p_transfer_id: transfer2, p_user_id: userId })
    check('cancel while IN_TRANSIT is now allowed', !cErr, cErr?.message ?? '')
    const afterCancel = await balance(srcId, srcItem)
    check('cancel RETURNS the stock to source', afterCancel === 20, `13 -> ${afterCancel}`)

    // ---------------------------------------------------------------- NEGATIVE CONTROLS
    console.log('\nNEGATIVE CONTROLS — the transitions that must still be refused')
    const { data: t3 } = await db.rpc('create_transfer', {
      p_organization_id: orgId, p_from_restaurant_id: srcId, p_to_restaurant_id: dstId,
      p_user_id: userId, p_items: [{ organization_stock_item_id: osiId, quantity_sent: 1, unit_id: unitId }],
    })
    const { error: rejDraft } = await db.rpc('reject_transfer', {
      p_transfer_id: String(t3), p_user_id: userId, p_reason: 'x',
    })
    check('rejecting a DRAFT is refused', Boolean(rejDraft), rejDraft?.message?.slice(0, 60) ?? 'NO ERROR')

    const beforeStray = await balance(srcId, srcItem)
    await db.rpc('cancel_transfer', { p_transfer_id: String(t3), p_user_id: userId })
    const afterDraftCancel = await balance(srcId, srcItem)
    check('cancelling a DRAFT moves NO stock', beforeStray === afterDraftCancel, `${beforeStray} -> ${afterDraftCancel}`)

    const { error: rejTwice } = await db.rpc('reject_transfer', {
      p_transfer_id: transfer1, p_user_id: userId, p_reason: 'again',
    })
    check('rejecting an already-REJECTED transfer is refused', Boolean(rejTwice), rejTwice?.message?.slice(0, 60) ?? 'NO ERROR')
    const afterDoubleReject = await balance(srcId, srcItem)
    check('and returns the stock only ONCE', afterDoubleReject === 20, `got ${afterDoubleReject}`)

    console.log(failures === 0 ? '\nVERIFY_335_TRANSFER_REJECT_OK' : `\n*** ${failures} CHECK(S) FAILED ***`)
  } finally {
    for (const rid of [srcId, dstId].filter(Boolean)) {
      const { data: xf } = await db.from('stock_transfers').select('id').or(`from_restaurant_id.eq.${rid},to_restaurant_id.eq.${rid}`)
      for (const t of xf ?? []) await db.from('stock_transfer_items').delete().eq('transfer_id', (t as any).id)
      await db.from('stock_transfers').delete().or(`from_restaurant_id.eq.${rid},to_restaurant_id.eq.${rid}`)
      await db.from('stock_movements').delete().eq('restaurant_id', rid)
      await db.from('stock_items').delete().eq('restaurant_id', rid)
    }
    if (osiId) await db.from('organization_stock_items').delete().eq('id', osiId)
    for (const rid of [srcId, dstId].filter(Boolean)) await db.from('restaurants').delete().eq('id', rid)
    if (orgId) await db.from('organizations').delete().eq('id', orgId)
    console.log('cleaned up')
  }
  if (failures > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
