import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveStaffMemberId } from '@/lib/permissions/authorize'
import { hasLineItemPreparationStarted } from '@/lib/orders/kitchen-prep-status'
import {
  findLineItemIndex,
  getLineQuantity,
  getLineSubtotal,
  getMenuItemId,
  orderItemsSubtotal,
  type OrderLineItem,
} from '@/lib/orders/order-line-item'
import {
  applyAmendmentStockEffects,
  resolveReducedQuantity,
} from '@/lib/orders/stock-amendment'
import type {
  AmendmentChangeInput,
  AmendOrderInput,
  AmendOrderResult,
  ResolvedAmendmentChange,
  StockAction,
} from '@/lib/orders/amend-types'
import { emitOrderAmended } from '@/lib/events/emit-order-amended'

const VALID_ACTIONS = new Set(['removed', 'added', 'quantity_changed', 'discount_applied'])

function parseChanges(raw: unknown): AmendmentChangeInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('changes must be a non-empty array')
  }

  return raw.map((entry, index) => {
    const row = entry as Record<string, unknown>
    const itemId = String(row.item_id || '').trim()
    const action = String(row.action || '').trim() as AmendmentChangeInput['action']

    if (!itemId) {
      throw new Error(`changes[${index}].item_id is required`)
    }
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`changes[${index}].action is invalid`)
    }

    const quantityDelta =
      row.quantity_delta == null ? undefined : Number(row.quantity_delta)
    const priceDelta = row.price_delta == null ? undefined : Number(row.price_delta)

    if (quantityDelta != null && !Number.isFinite(quantityDelta)) {
      throw new Error(`changes[${index}].quantity_delta must be numeric`)
    }
    if (priceDelta != null && !Number.isFinite(priceDelta)) {
      throw new Error(`changes[${index}].price_delta must be numeric`)
    }

    return {
      item_id: itemId,
      action,
      quantity_delta: quantityDelta,
      price_delta: priceDelta,
      reason: row.reason != null ? String(row.reason).trim() || undefined : undefined,
    }
  })
}

function resolveStockAction(
  order: { status?: string | null; preparing_at?: string | null; accepted_at?: string | null },
  lineItem: OrderLineItem | null,
  change: AmendmentChangeInput,
): StockAction {
  if (!lineItem) return 'none'

  const reducedQty = resolveReducedQuantity(change.action, lineItem, change.quantity_delta ?? 0)
  if (reducedQty <= 0) return 'none'

  return hasLineItemPreparationStarted(order, lineItem) ? 'waste' : 'reversed'
}

function applyChangeToItems(
  items: OrderLineItem[],
  change: AmendmentChangeInput,
): { items: OrderLineItem[]; priceDelta: number } {
  const next = items.map((item) => ({ ...item }))

  if (change.action === 'added') {
    const qty = Math.max(1, Math.abs(change.quantity_delta ?? 1))
    const unitPrice =
      change.price_delta != null && qty > 0 ? Math.abs(change.price_delta) / qty : 0
    const subtotal = change.price_delta ?? unitPrice * qty
    next.push({
      id: randomUUID(),
      menuItemId: change.item_id,
      menu_item_id: change.item_id,
      quantity: qty,
      basePrice: unitPrice,
      subtotal,
    })
    return { items: next, priceDelta: Number(change.price_delta ?? subtotal) }
  }

  const index = findLineItemIndex(next, change.item_id)
  if (index < 0) {
    throw new Error(`Line item not found: ${change.item_id}`)
  }

  const current = next[index]
  const beforeSubtotal = getLineSubtotal(current)

  if (change.action === 'removed') {
    next.splice(index, 1)
    return {
      items: next,
      priceDelta: change.price_delta ?? -beforeSubtotal,
    }
  }

  if (change.action === 'quantity_changed') {
    const delta = Number(change.quantity_delta ?? 0)
    const currentQty = getLineQuantity(current)
    const newQty = Math.max(0, currentQty + delta)
    if (newQty === 0) {
      next.splice(index, 1)
      return {
        items: next,
        priceDelta: change.price_delta ?? -beforeSubtotal,
      }
    }
    const unitPrice = currentQty > 0 ? beforeSubtotal / currentQty : 0
    current.quantity = newQty
    const afterSubtotal = unitPrice * newQty
    current.subtotal = afterSubtotal
    return {
      items: next,
      priceDelta: change.price_delta ?? afterSubtotal - beforeSubtotal,
    }
  }

  if (change.action === 'discount_applied') {
    const discountAmount = Math.abs(Number(change.price_delta ?? 0))
    current.discount = (Number(current.discount) || 0) + discountAmount
    current.subtotal = Math.max(0, beforeSubtotal - discountAmount)
    return {
      items: next,
      priceDelta: change.price_delta ?? current.subtotal - beforeSubtotal,
    }
  }

  return { items: next, priceDelta: Number(change.price_delta ?? 0) }
}

function computeFinancialDelta(changes: ResolvedAmendmentChange[]): number {
  return changes.reduce((sum, change) => sum + Number(change.price_delta ?? 0), 0)
}

export async function amendOrder(
  supabase: SupabaseClient,
  userId: string,
  input: AmendOrderInput,
): Promise<AmendOrderResult> {
  const orderId = String(input.orderId || '').trim()
  const changes = parseChanges(input.changes)
  const managerReason = String(input.reason || '').trim() || null

  const { data: order, error: loadError } = await supabase
    .from('orders')
    .select(
      'id, restaurant_id, status, preparing_at, accepted_at, payment_status, subtotal, total, tax, items',
    )
    .eq('id', orderId)
    .maybeSingle()

  if (loadError) throw loadError
  if (!order?.restaurant_id) {
    throw new Error('Order not found')
  }

  const paymentStatus = String(order.payment_status || '').toLowerCase()
  if (paymentStatus !== 'paid') {
    throw new Error('Amendments are only allowed on paid orders')
  }

  if (String(order.status || '').toLowerCase() === 'cancelled') {
    throw new Error('Cannot amend a cancelled order')
  }

  const amendedBy = await resolveStaffMemberId(userId, String(order.restaurant_id))
  if (!amendedBy) {
    throw new Error('Staff member record not found for this account')
  }

  let items = (Array.isArray(order.items) ? order.items : []) as OrderLineItem[]
  const resolvedChanges: ResolvedAmendmentChange[] = []

  for (const change of changes) {
    const lineIndex = findLineItemIndex(items, change.item_id)
    const lineItem = lineIndex >= 0 ? items[lineIndex] : null
    const stockAction =
      change.action === 'added' || change.action === 'discount_applied'
        ? ('none' as StockAction)
        : resolveStockAction(order, lineItem, change)

    const applied = applyChangeToItems(items, change)
    items = applied.items

    resolvedChanges.push({
      ...change,
      price_delta: applied.priceDelta,
      stock_action: stockAction,
    })
  }

  const financialDelta = computeFinancialDelta(resolvedChanges)
  const subtotal = orderItemsSubtotal(items)
  const tax = Number(order.tax ?? 0)
  const total = Math.max(0, subtotal + tax)

  const { data: revision, error: revisionError } = await supabase
    .from('order_revisions')
    .insert({
      restaurant_id: order.restaurant_id,
      order_id: orderId,
      amended_by: amendedBy,
      reason: managerReason,
      changes: resolvedChanges,
      financial_delta: financialDelta,
    })
    .select('id, revision_number, created_at')
    .single()

  if (revisionError) throw revisionError

  for (const change of resolvedChanges) {
    if (change.stock_action === 'none') continue

    const lineIndex = findLineItemIndex(
      (Array.isArray(order.items) ? order.items : []) as OrderLineItem[],
      change.item_id,
    )
    const lineItem =
      lineIndex >= 0
        ? ((Array.isArray(order.items) ? order.items : []) as OrderLineItem[])[lineIndex]
        : null
    if (!lineItem) continue

    const reducedQuantity = resolveReducedQuantity(
      change.action,
      lineItem,
      change.quantity_delta ?? 0,
    )

    await applyAmendmentStockEffects({
      supabase,
      restaurantId: String(order.restaurant_id),
      orderId,
      revisionId: String(revision.id),
      lineItem,
      reducedQuantity,
      stockAction: change.stock_action,
      createdBy: userId,
      notes: change.reason || managerReason || `Order amendment ${revision.revision_number}`,
    })
  }

  const { data: updatedOrder, error: updateError } = await supabase
    .from('orders')
    .update({
      items,
      subtotal,
      total,
    })
    .eq('id', orderId)
    .eq('restaurant_id', order.restaurant_id)
    .select('id, subtotal, total, items, status, payment_status')
    .single()

  if (updateError) throw updateError

  const result: AmendOrderResult = {
    revisionId: String(revision.id),
    revisionNumber: Number(revision.revision_number),
    financialDelta,
    changes: resolvedChanges,
    order: {
      id: String(updatedOrder.id),
      subtotal: Number(updatedOrder.subtotal),
      total: Number(updatedOrder.total),
      items: updatedOrder.items ?? [],
      status: String(updatedOrder.status),
      payment_status: String(updatedOrder.payment_status),
    },
  }

  await emitOrderAmended({
    event_id: randomUUID(),
    event_type: 'order.amended',
    occurred_at: String(revision.created_at ?? new Date().toISOString()),
    restaurant_id: String(order.restaurant_id),
    order_id: orderId,
    revision_id: result.revisionId,
    revision_number: result.revisionNumber,
    amended_by: amendedBy,
    reason: managerReason,
    financial_delta: financialDelta,
    changes: resolvedChanges,
    order: result.order,
  })

  return result
}
