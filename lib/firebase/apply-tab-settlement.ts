import { FieldValue, adminDb } from '@/lib/firebase/admin-firestore'
import { ordersPath, tabPath } from '@/lib/firebase/paths'

export function markPaidAndAcceptPatch(currentStatus: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    payment_status: 'paid',
    paid_at: FieldValue.serverTimestamp(),
    payment_provider: 'paycloud',
    updated_at: FieldValue.serverTimestamp(),
  }
  const cs = String(currentStatus || '').toLowerCase()
  if (cs === 'new' || !cs) {
    return {
      ...base,
      status: 'accepted',
      accepted_at: FieldValue.serverTimestamp(),
    }
  }
  return base
}

export function markPaidAndCompletedPatch(): Record<string, unknown> {
  return {
    payment_status: 'paid',
    paid_at: FieldValue.serverTimestamp(),
    payment_provider: 'paycloud',
    status: 'completed',
    completed_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }
}

/** PayCloud webhook: same lifecycle as reconcile (paid + accepted when still new). */
export function buildWebhookPaidPatch(currentStatus: string, transNoStr: string | null): Record<string, unknown> {
  return {
    ...markPaidAndAcceptPatch(currentStatus),
    payment_trans_no: transNoStr,
    paycloud_transaction_id: transNoStr || null,
    is_closed: false,
  }
}

async function markTabOrdersPaid(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  restaurantId: string,
  settlementTabId: string
) {
  const tabOrdersSnapshot = await fs
    .collection(ordersPath(restaurantId))
    .where('tab_id', '==', settlementTabId)
    .get()

  for (const tabOrderDoc of tabOrdersSnapshot.docs) {
    await tabOrderDoc.ref.update(markPaidAndCompletedPatch())
  }
}

/**
 * Full tab: mark tab settled and every order on that tab (including settlement row) paid + accepted when new.
 */
async function applyFullTabSettlement(restaurantId: string, settlementTabId: string): Promise<void> {
  const fs = adminDb()
  if (!fs) return

  await fs.doc(tabPath(restaurantId, settlementTabId)).update({
    status: 'settled',
    settled_at: FieldValue.serverTimestamp(),
    settlement_type: 'full',
    updated_at: FieldValue.serverTimestamp(),
  })

  await markTabOrdersPaid(fs, restaurantId, settlementTabId)
}

/**
 * One member paid their share: mark only that member's tab line orders paid; reduce tab total; tab stays open.
 */
async function applyMemberTabSettlement(
  restaurantId: string,
  settlementTabId: string,
  memberSession: string,
  settlementOrderData: Record<string, unknown>
): Promise<void> {
  const fs = adminDb()
  if (!fs || !memberSession) return

  const snap = await fs.collection(ordersPath(restaurantId)).where('tab_id', '==', settlementTabId).get()

  let memberOrdersTotal = 0
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>
    if (String(data.tab_settlement_for_tab_id || '').trim()) continue

    const mid = String(data.member_session_id || data.session_id || '').trim()
    if (mid !== memberSession) continue

    if (String(data.payment_status || '').toLowerCase() === 'paid') continue

    await d.ref.update(markPaidAndCompletedPatch())
    memberOrdersTotal += Number(data.total) || 0
  }

  const settleAmount = Number(settlementOrderData.total) || 0
  const delta = memberOrdersTotal > 0 ? memberOrdersTotal : settleAmount
  if (delta > 0) {
    await fs.doc(tabPath(restaurantId, settlementTabId)).update({
      total: FieldValue.increment(-delta),
      updated_at: FieldValue.serverTimestamp(),
    })
  }
}

/**
 * After Finatic reports paid: full-tab settlement, member-only settlement, or nothing.
 * Standalone orders (no tab_settlement_for_tab_id) are a no-op here.
 */
export async function applyTabSettlementSideEffects(
  restaurantId: string,
  orderData: Record<string, unknown>
): Promise<'full' | 'member' | 'none'> {
  const settlementTabId = String(orderData.tab_settlement_for_tab_id || '').trim()
  if (!settlementTabId) return 'none'

  const memberSession = String(orderData.tab_settlement_member_session_id || '').trim()
  if (memberSession) {
    await applyMemberTabSettlement(restaurantId, settlementTabId, memberSession, orderData)
    return 'member'
  }

  await applyFullTabSettlement(restaurantId, settlementTabId)
  return 'full'
}

/** @deprecated use applyTabSettlementSideEffects */
export async function applyFullTabSettlementIfNeeded(
  restaurantId: string,
  orderData: Record<string, unknown>
): Promise<boolean> {
  const r = await applyTabSettlementSideEffects(restaurantId, orderData)
  return r === 'full'
}
