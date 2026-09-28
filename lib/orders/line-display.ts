/**
 * How a stored `orders.items[]` line is NAMED and PRICED on the staff dashboards.
 * Sprint 2026-09-28 (C6).
 *
 * THE NAME. Order history and the orders dashboard read `display_name || name`, but no writer
 * stores `display_name`: the customer cart and the terminal pricer both store camelCase
 * `displayName` (and the pricer spreads it into `orders.items`). So the variant-bearing name was
 * never the one read, and a line fell back to whatever `name` held. Both spellings are accepted
 * here, snake first so nothing that did render a `display_name` changes.
 *
 * THE MONEY. `unitPrice` and `total` are the server's own figures (calculate-order-pricing), the
 * same ones a receipt copies. A line without a finite server figure renders no price rather than
 * a guessed one.
 */
export type DisplayableOrderLine = {
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  unitPrice?: unknown
  total?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function orderLineDisplayName(line: DisplayableOrderLine | null | undefined, fallback = 'Item'): string {
  if (!line) return fallback
  return text(line.display_name) || text(line.displayName) || text(line.name) || fallback
}

export function orderLineMoney(
  line: DisplayableOrderLine | null | undefined,
): { unitPrice: number; total: number } | null {
  if (!line) return null
  const unitPrice = line.unitPrice
  const total = line.total
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice)) return null
  if (typeof total !== 'number' || !Number.isFinite(total)) return null
  return { unitPrice, total }
}
