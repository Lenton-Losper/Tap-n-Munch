import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from './restaurants'

export function markPaidAndAcceptPatch(currentStatus: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    payment_status: 'paid',
    paid_at: new Date().toISOString(),
    payment_provider: 'paycloud',
    updated_at: new Date().toISOString(),
  }
  const cs = String(currentStatus || '').toLowerCase()
  if (cs === 'pending' || !cs) {
    return {
      ...base,
      status: 'accepted',
      accepted_at: new Date().toISOString(),
    }
  }
  return base
}

export function markPaidAndCompletedPatch(): Record<string, unknown> {
  return {
    payment_status: 'paid',
    paid_at: new Date().toISOString(),
    payment_provider: 'paycloud',
    status: 'completed',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

export function buildWebhookPaidPatch(currentStatus: string, transNoStr: string | null): Record<string, unknown> {
  return {
    ...markPaidAndAcceptPatch(currentStatus),
    payment_trans_no: transNoStr,
    paycloud_transaction_id: transNoStr || null,
    is_closed: false,
  }
}

export function buildWebhookTerminalPaidPatch(transNoStr: string | null): Record<string, unknown> {
  return {
    ...markPaidAndCompletedPatch(),
    payment_trans_no: transNoStr,
    paycloud_transaction_id: transNoStr || null,
    is_closed: false,
  }
}

async function markTabOrdersPaid(restaurantId: string, settlementTabId: string) {
  const supabase = createServerSupabaseClient()
  const { data: rows, error } = await supabase
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('tab_id', settlementTabId)
  if (error) throw error
  for (const row of rows || []) {
    const { error: updateError } = await supabase
      .from('orders')
      .update(markPaidAndCompletedPatch())
      .eq('id', row.id)
    if (updateError) throw updateError
  }
}

/**
 * The tab settlement write, and then the orders.
 *
 * ORDER MATTERS AND SO DOES THE GUARD (#195). The result of this update used to be discarded, so
 * a settlement that wrote nothing was followed unconditionally by markTabOrdersPaid -- leaving
 * every order on the tab paid, the tab still open, and nothing surfaced to the caller or the
 * operator. Staff would see a tab that will not close after a successful card payment.
 *
 * It wrote nothing because the payload named two columns `tabs` does not have. Verified read-only
 * against BOTH staging and production, and absent from every committed migration (baseline
 * included -- `grep -rn settlement_type supabase/migrations/` returns nothing):
 *
 *   settlement_type -- ABSENT. `settled_type` below already carries card_payment / manual_close,
 *                      and full-vs-member is carried by which function runs, not by a column.
 *   updated_at      -- ABSENT. Nothing else on `tabs` maintains it. (`orders.updated_at` DOES
 *                      exist -- added by 20260714130000 for the patch builders above -- so do not
 *                      read its removal here as applying to that table.)
 *
 * PostgREST rejects the whole statement when a payload names an unknown column, so neither field
 * was decoration: their presence is what made the settlement silently do nothing.
 */
async function applyFullTabSettlement(restaurantId: string, settlementTabId: string): Promise<void> {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('tabs')
    .update({
      status: 'settled',
      settled_at: new Date().toISOString(),
      settled_type: 'card_payment',
    })
    .eq('restaurant_id', restaurantId)
    .eq('id', settlementTabId)
  if (error) throw error
  await markTabOrdersPaid(restaurantId, settlementTabId)
}

async function applyMemberTabSettlement(
  restaurantId: string,
  settlementTabId: string,
  memberSession: string,
  settlementOrderData: Record<string, unknown>
): Promise<void> {
  const supabase = createServerSupabaseClient()
  const { data: rows } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('tab_id', settlementTabId)

  let memberOrdersTotal = 0
  for (const data of rows || []) {
    if (String((data as any).tab_settlement_for_tab_id || '').trim()) continue
    const mid = String((data as any).member_session_id || (data as any).session_id || '').trim()
    if (mid !== memberSession) continue
    if (String((data as any).payment_status || '').toLowerCase() === 'paid') continue
    const { error: paidError } = await supabase
      .from('orders')
      .update(markPaidAndCompletedPatch())
      .eq('id', (data as any).id)
    if (paidError) throw paidError
    memberOrdersTotal += Number((data as any).total) || 0
  }

  const settleAmount = Number(settlementOrderData.total) || 0
  const delta = memberOrdersTotal > 0 ? memberOrdersTotal : settleAmount
  if (delta > 0) {
    const { data: tab } = await supabase
      .from('tabs')
      .select('total')
      .eq('restaurant_id', restaurantId)
      .eq('id', settlementTabId)
      .single()
    const current = Number((tab as any)?.total) || 0
    // Same two properties as the full path: the member's orders are already marked paid by the
    // loop above, so a tab balance that silently fails to come down is money owed twice. And
    // `tabs.updated_at` does not exist, which is what made this write fail in the first place.
    const { error: totalError } = await supabase
      .from('tabs')
      .update({ total: Math.max(0, current - delta) })
      .eq('restaurant_id', restaurantId)
      .eq('id', settlementTabId)
    if (totalError) throw totalError
  }
}

export async function applyTabSettlementSideEffects(
  restaurantId: string,
  orderData: Record<string, unknown>
): Promise<'full' | 'member' | 'none'> {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const settlementTabId = String(orderData.tab_settlement_for_tab_id || '').trim()
  if (!settlementTabId) return 'none'
  const memberSession = String(orderData.tab_settlement_member_session_id || '').trim()
  if (memberSession) {
    await applyMemberTabSettlement(restaurantUuid, settlementTabId, memberSession, orderData)
    return 'member'
  }
  await applyFullTabSettlement(restaurantUuid, settlementTabId)
  return 'full'
}

export async function applyFullTabSettlementIfNeeded(
  restaurantId: string,
  orderData: Record<string, unknown>
): Promise<boolean> {
  const r = await applyTabSettlementSideEffects(restaurantId, orderData)
  return r === 'full'
}
