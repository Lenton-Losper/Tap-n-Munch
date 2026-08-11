import type { SupabaseClient } from '@supabase/supabase-js'

import { findNegativeBalances, type MovementRow, type NegativeBalance } from '@/lib/stock/negative-balances'

/**
 * #146 — the scheduled half of detection.
 *
 * The issue's point is that the -22 was never the expensive part: the three weeks of silence
 * were. A negative balance appeared on 6 July on the first bad deduction and nothing said so
 * until an unrelated investigation on 2 August. This reports it.
 *
 * REPORT ONLY. Nothing here writes, and nothing here is on an order path -- it cannot refuse a
 * sale or fail a deduction. Whether a deduction that would drive a balance negative should be
 * REFUSED is #146 recommendation 4, a customer-facing business decision that is deliberately
 * not taken here.
 */

export type NegativeBalanceReportRow = NegativeBalance & {
  name: string
  parLevel: number | null
  restaurantId: string
}

export type NegativeBalanceReport = {
  scanned: number
  negativeCount: number
  byRestaurant: Array<{ restaurantId: string; rows: NegativeBalanceReportRow[] }>
}

/**
 * Group flagged items per restaurant, worst first within each, worst-hosting restaurant first.
 *
 * Per restaurant because that is the unit a human acts on -- one merchant's mis-counted
 * ingredient is not another's problem, and a flat global list buries a single bad item under a
 * noisy tenant.
 */
export function groupNegativesByRestaurant(
  rows: NegativeBalanceReportRow[],
): NegativeBalanceReport['byRestaurant'] {
  const byRestaurant = new Map<string, NegativeBalanceReportRow[]>()
  for (const row of rows) {
    const existing = byRestaurant.get(row.restaurantId)
    if (existing) existing.push(row)
    else byRestaurant.set(row.restaurantId, [row])
  }

  return [...byRestaurant.entries()]
    .map(([restaurantId, group]) => ({
      restaurantId,
      rows: [...group].sort((a, b) => a.balance - b.balance),
    }))
    .sort((a, b) => (a.rows[0]?.balance ?? 0) - (b.rows[0]?.balance ?? 0))
}

const PAGE = 1000

/**
 * Scan every movement, aggregate per stock item, and report the impossible ones.
 *
 * Reads the whole movement ledger because a balance is a SUM over all of it -- there is no
 * quantity column to read and no way to look at only recent rows and know a total. That is
 * acceptable at current volume and will not be forever; the replacement is a database-side
 * aggregate so the sum happens where the rows live. Noted rather than built because it needs a
 * migration, and this needs to work before one is applied.
 */
export async function reportNegativeStockBalances(
  supabase: SupabaseClient,
): Promise<NegativeBalanceReport> {
  const movements: MovementRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('stock_item_id, quantity_delta')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) throw new Error(`stock_movements read failed: ${error.message}`)
    if (!data || data.length === 0) break
    movements.push(...(data as MovementRow[]))
    // A short page is the last page. Without this the loop costs one extra round trip per scan,
    // and on an exact multiple of PAGE it is the only thing that ends it.
    if (data.length < PAGE) break
  }

  const negatives = findNegativeBalances(movements)
  if (negatives.length === 0) {
    return { scanned: movements.length, negativeCount: 0, byRestaurant: [] }
  }

  const { data: items, error: itemsError } = await supabase
    .from('stock_items')
    .select('id, name, par_level, restaurant_id')
    .in(
      'id',
      negatives.map((n) => n.stockItemId),
    )

  if (itemsError) throw new Error(`stock_items read failed: ${itemsError.message}`)

  const byId = new Map((items ?? []).map((row) => [String(row.id), row]))

  const rows: NegativeBalanceReportRow[] = negatives.map((negative) => {
    const item = byId.get(negative.stockItemId)
    return {
      ...negative,
      name: String(item?.name ?? '(unknown stock item)'),
      parLevel: item?.par_level == null ? null : Number(item.par_level),
      restaurantId: String(item?.restaurant_id ?? '(unknown restaurant)'),
    }
  })

  return {
    scanned: movements.length,
    negativeCount: rows.length,
    byRestaurant: groupNegativesByRestaurant(rows),
  }
}
