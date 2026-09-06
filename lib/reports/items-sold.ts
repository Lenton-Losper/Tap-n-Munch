/**
 * WHAT WAS SOLD — the item half of a cash-up.
 *
 * ================================================================================================
 * WHY THIS IS ITS OWN FUNCTION
 * ================================================================================================
 *
 * It was written inline in getReportData, which needs a database, so nothing tested it. A mutation
 * sweep on 2026-09-07 proved that: capping the list at ten, switching the money to ex-VAT, and
 * dropping zero-quantity lines all left every test green. Three real defects, invisible.
 *
 * It is pure, so it is tested directly.
 *
 * ================================================================================================
 * THE THREE DECISIONS IT ENCODES
 * ================================================================================================
 *
 * UNCAPPED. `lib/supabase/analytics.ts` already had an items breakdown and it is a top-10: right
 * for a dashboard tile answering "what sells", wrong here. A cash-up lists what went out of the
 * kitchen, and a truncated list is one somebody reconciles against a drawer while wondering what
 * the eleventh line was.
 *
 * GROSS, MATCHING THE TAKINGS. `item.total` is the VAT-inclusive line total — the tax invoice's
 * basis, and the one that sums to `orders.total`. `item.subtotal` is ex-VAT and would produce an
 * item list that does not add up to the money taken, which is the one property a cash-up needs.
 *
 * A MISSING QUANTITY COUNTS AS ONE, NEVER ZERO. A line with no quantity is still a thing that was
 * sold and charged for; dropping it would leave the item list short against the bill.
 *
 * GROUPED BY menu_item_id where there is one, so a dish renamed mid-period does not split into two
 * lines; falls back to the name for anything that predates the id.
 */

export type ItemSold = { name: string; quantity: number; gross: number }

type OrderLike = { items?: unknown }

export function aggregateItemsSold(orders: ReadonlyArray<OrderLike>): ItemSold[] {
  const byItem = new Map<string, ItemSold>()

  for (const order of orders) {
    const items = Array.isArray(order.items) ? (order.items as Array<Record<string, unknown>>) : []
    for (const item of items) {
      const name = String(item.display_name ?? item.name ?? 'Unknown item')
      const key = String(item.menu_item_id ?? item.id ?? name)
      const entry = byItem.get(key) ?? { name, quantity: 0, gross: 0 }
      const quantity = Number(item.quantity)
      entry.quantity += Number.isFinite(quantity) && quantity > 0 ? quantity : 1
      entry.gross += Number(item.total ?? 0)
      byItem.set(key, entry)
    }
  }

  return [...byItem.values()]
    .map((v) => ({ name: v.name, quantity: v.quantity, gross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
}
