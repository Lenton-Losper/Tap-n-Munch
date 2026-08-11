/**
 * #146 — detection of impossible stock balances.
 *
 * Balances are DERIVED: `stock_items` has no quantity column, and an item's level is
 * `sum(stock_movements.quantity_delta)`. So "is this balance negative" is not a column read and
 * cannot be a table CHECK constraint -- it is a question about a whole group of rows. That shape
 * is why nothing in the schema was ever going to catch it.
 *
 * This module answers the question and nothing more. It does not write, does not refuse, and is
 * not on any order path. Refusing a deduction is a separate, customer-facing decision (#146
 * recommendation 4) that is deliberately not taken here.
 */

export type NegativeBalance = {
  stockItemId: string
  balance: number
  movementCount: number
}

export type MovementRow = {
  stock_item_id: string
  quantity_delta: number | string | null
}

/**
 * Sum movements per stock item.
 *
 * Deliberately the same shape and the same `Number(x) || 0` coercion as the private
 * `aggregateStockByItem` in lib/stock/queries.ts:62, so detection cannot disagree with the
 * balance the stock screen displays. Duplicated rather than exported from there on purpose:
 * queries.ts is a Supabase-bound server module, and this one has to stay importable by a plain
 * script and by a hermetic test.
 */
function aggregateStockByItem(movements: MovementRow[]): Map<string, number> {
  const stockByItem = new Map<string, number>()
  for (const movement of movements) {
    const id = String(movement.stock_item_id)
    const delta = Number(movement.quantity_delta) || 0
    stockByItem.set(id, (stockByItem.get(id) ?? 0) + delta)
  }
  return stockByItem
}

/**
 * Stock items whose movements sum below zero, worst first.
 *
 * Rounded to 4dp before the comparison because `quantity_delta` is numeric(_,4) and arrives over
 * PostgREST as a string or a float. Without it, a set of movements that cancel exactly can land
 * at -1e-15 through float addition alone and be reported as an impossible balance -- a false
 * alarm on an item that is precisely zero. The rounding is at the same precision the database
 * stores, so it cannot hide a real negative: the smallest representable one is -0.0001.
 */
export function findNegativeBalances(movements: MovementRow[]): NegativeBalance[] {
  const balances = aggregateStockByItem(movements)

  const counts = new Map<string, number>()
  for (const row of movements) {
    const id = String(row.stock_item_id)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  const negatives: NegativeBalance[] = []
  for (const [stockItemId, raw] of balances) {
    const balance = Math.round(raw * 10000) / 10000
    if (balance < 0) {
      negatives.push({ stockItemId, balance, movementCount: counts.get(stockItemId) ?? 0 })
    }
  }

  return negatives.sort((a, b) => a.balance - b.balance)
}
