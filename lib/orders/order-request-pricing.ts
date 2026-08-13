/**
 * Which items and totals an order_request actually stands for, in ONE place.
 *
 * There are now three tiers of figures on the row, all of them server-priced:
 *
 *   items / subtotal / tax / total                  the customer's original submission,
 *                                                    never mutated after insert (audit trail,
 *                                                    declared in 20260726100000)
 *   items_customer / *_customer                     the customer's own later amendment
 *                                                    (20260813120000, order editing)
 *   items_reviewed / *_reviewed                     staff edits saved during review
 *
 * Precedence is reviewed ?? customer ?? original — the most recent writer wins, and a
 * customer edit nulls any saved review so this stays true rather than depending on the order
 * the columns happen to be filled in.
 *
 * Before this existed the precedence was written out twice — in the Accept route and in
 * lib/guest-orders/queries.ts's mapOrderRequestToGuestRow — and the dashboard card had a
 * third copy of the two-tier version. Three copies of "what is this order worth" is how the
 * customer's confirmation screen and the amount Finatic charges come to disagree, so the
 * callers now import this instead. A test that binds here binds to what ships (#205).
 */

export type OrderRequestPricingRow = {
  items?: unknown
  subtotal?: unknown
  tax?: unknown
  total?: unknown
  items_customer?: unknown
  subtotal_customer?: unknown
  tax_customer?: unknown
  total_customer?: unknown
  items_reviewed?: unknown
  subtotal_reviewed?: unknown
  tax_reviewed?: unknown
  total_reviewed?: unknown
}

export type EffectiveRequestPricing = {
  items: unknown[]
  subtotal: number
  tax: number
  total: number
  /** Which tier the figures came from. Drives the dashboard's badge, not any arithmetic. */
  source: 'staff_reviewed' | 'customer_edited' | 'original'
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function effectiveRequestPricing(row: OrderRequestPricingRow): EffectiveRequestPricing {
  if (Array.isArray(row.items_reviewed)) {
    return {
      items: row.items_reviewed,
      subtotal: num(row.subtotal_reviewed),
      tax: num(row.tax_reviewed),
      total: num(row.total_reviewed),
      source: 'staff_reviewed',
    }
  }
  if (Array.isArray(row.items_customer)) {
    return {
      items: row.items_customer,
      subtotal: num(row.subtotal_customer),
      tax: num(row.tax_customer),
      total: num(row.total_customer),
      source: 'customer_edited',
    }
  }
  return {
    items: Array.isArray(row.items) ? row.items : [],
    subtotal: num(row.subtotal),
    tax: num(row.tax),
    total: num(row.total),
    source: 'original',
  }
}
