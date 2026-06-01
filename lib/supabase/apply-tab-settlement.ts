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
  if (cs === 'new' || !cs) {
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
    await supabase.from('orders').update(markPaidAndCompletedPatch()).eq('id', row.id)
  }
}

async function applyFullTabSettlement(restaurantId: string, settlementTabId: string): Promise<void> {
  const supabase = createServerSupabaseClient()
  await supabase
    .from('tabs')
    .update({
      status: 'settled',
      settled_at: new Date().toISOString(),
      settlement_type: 'full',
      settled_type: 'card_payment',
      updated_at: new Date().toISOString(),
    })
    .eq('restaurant_id', restaurantId)
    .eq('id', settlementTabId)
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
    await supabase.from('orders').update(markPaidAndCompletedPatch()).eq('id', (data as any).id)
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
    await supabase
      .from('tabs')
      .update({ total: Math.max(0, current - delta), updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId)
      .eq('id', settlementTabId)
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
