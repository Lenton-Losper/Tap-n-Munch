/**
 * WHAT A GUEST'S ORDER IS WORTH NOW, attached to the rows the guest routes already return.
 *
 * `amend_order_lines` never rewrites an order: when staff void a line it stays in `items` and in
 * `total`, and a reduction's surviving quantity appears as a NEW order on the same tab. A customer
 * reading `total` off their own order was told they owed for food the waiter had cancelled -- and,
 * after a reduction, saw the surviving quantity twice.
 *
 * This attaches, per ORDER row (never to an order_request, which cannot have been amended):
 *
 *   live_total   the order's value now: stored total less voided lines (major units)
 *   financials   the full C1 projection in integer cents (lib/orders/order-financials.ts)
 *   items[i].voided = true   on each line staff voided, so a screen can show it went
 *
 * `total` itself is left EXACTLY as stored. It is the historical figure and other readers
 * (receipts, the edit panel's before/after) depend on it meaning what it has always meant.
 *
 * DISPLAY ONLY, AND DEGRADES VISIBLY. A failed lines/ledger read leaves the rows as they were and
 * `live_total` absent, so a screen falls back to the stored total it has always shown rather than
 * inventing a smaller figure. Nothing here decides what anybody is charged.
 */
import {
  centsToMajor,
  computeOrderFinancials,
  financialsWire,
  readProjectionInputs,
  type FinancialOrderInput,
  type FinancialsWire,
} from '@/lib/orders/order-financials'

/** What an order row gains. Optional: a failed read returns the rows without them. */
export type GuestFinancialFields = { live_total?: number; financials?: FinancialsWire }

type Supabase = Parameters<typeof readProjectionInputs>[0]

function isOrderRow(row: Record<string, unknown>): boolean {
  return String(row.surface ?? 'orders') === 'orders' && Boolean(String(row.id ?? '').trim())
}

export async function attachGuestFinancials<T extends Record<string, unknown>>(
  supabase: Supabase,
  rows: T[],
): Promise<Array<T & GuestFinancialFields>> {
  const orderRows = rows.filter(isOrderRow)
  if (orderRows.length === 0) return rows

  let inputs: Awaited<ReturnType<typeof readProjectionInputs>>
  try {
    inputs = await readProjectionInputs(
      supabase,
      orderRows.map((r) => String(r.id)),
    )
  } catch (e) {
    console.error('[guest-financials] projection inputs unreadable; showing stored totals', {
      error: e instanceof Error ? e.message : String(e),
    })
    return rows
  }

  return rows.map((row) => {
    if (!isOrderRow(row)) return row
    const fin = computeOrderFinancials(
      row as unknown as FinancialOrderInput,
      inputs.lines,
      inputs.allocationSettledByOrder.get(String(row.id)) ?? 0,
    )
    const voidedIndexes = new Set(fin.lines.filter((l) => l.voided).map((l) => l.sourceItemIndex))
    const items = Array.isArray(row.items)
      ? (row.items as unknown[]).map((item, index) =>
          voidedIndexes.has(index) && item && typeof item === 'object'
            ? { ...(item as Record<string, unknown>), voided: true }
            : item,
        )
      : row.items
    return {
      ...row,
      items,
      live_total: centsToMajor(fin.liveCents),
      financials: financialsWire(fin),
    }
  })
}
