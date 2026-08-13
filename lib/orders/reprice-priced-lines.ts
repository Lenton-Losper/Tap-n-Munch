/**
 * Recompute an order's totals after a customer REMOVES lines or REDUCES quantities, from the
 * order's own already-priced line items.
 *
 * Why not calculateOrderPricing. That function is the right answer everywhere a customer
 * chooses items: it reads the live menu and is the only thing allowed to decide what
 * something costs (cart prices are display-only — the server reprices every line and
 * discards client amounts). But an EDIT is not a new order. Repricing the survivors against
 * the live menu would move the price of items the customer is keeping, because the menu can
 * have changed since the order was placed and accepted — and it would throw
 * UnmatchedMenuItemError if any surviving item has since gone `out_of_stock`, refusing a
 * removal for a reason that has nothing to do with what the customer asked to remove.
 *
 * So: removals and reductions are computed from the stored priced lines, which already carry
 * the unitPrice, rate and inclusivity that calculateOrderPricing decided at placement. The
 * customer keeps exactly the price they were quoted and staff accepted. Nothing here can
 * raise a line's price, and no client-supplied amount is read — the request names line
 * indexes and quantities only.
 *
 * The tax split is NOT recomputed by hand: it calls applyTaxToAmount, the same primitive
 * calculateOrderPricing uses, so inclusive/exclusive handling cannot drift between the two.
 */
import { round2, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'

export type StoredPricedLine = Record<string, unknown> & {
  unitPrice?: unknown
  quantity?: unknown
  subtotal?: unknown
  tax?: unknown
  total?: unknown
  taxRatePercentage?: unknown
  taxInclusive?: unknown
}

export type RepricedResult = {
  items: StoredPricedLine[]
  subtotal: number
  tax: number
  total: number
}

/** One instruction per surviving line: which stored line, and how many of it remain. */
export type LineKeepInstruction = {
  index: number
  quantity: number
}

export class InvalidEditError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEditError'
  }
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Unit price for a stored line. Prefers the recorded unitPrice; falls back to
 * subtotal-or-total / quantity for rows priced before unitPrice was persisted, so an older
 * order is editable rather than silently refused. For an inclusive rate the charged amount is
 * `total`, and for an exclusive rate it is `subtotal` — applyTaxToAmount is fed the raw
 * charged amount in both cases, so the fallback must pick the matching one.
 */
function unitPriceOf(line: StoredPricedLine): number {
  const recorded = num(line.unitPrice)
  if (recorded > 0) return recorded

  const quantity = num(line.quantity)
  if (quantity <= 0) return 0
  const inclusive = line.taxInclusive !== false
  const charged = inclusive ? num(line.total) || num(line.subtotal) : num(line.subtotal) || num(line.total)
  return charged / quantity
}

/**
 * Apply keep-instructions to the stored lines and re-sum. Throws InvalidEditError on anything
 * that is not a strict reduction of what is already there — an edit may never introduce a
 * line, raise a quantity, or empty the order.
 */
export function repriceKeptLines(
  storedItems: unknown,
  keep: LineKeepInstruction[],
): RepricedResult {
  const lines = (Array.isArray(storedItems) ? storedItems : []) as StoredPricedLine[]

  if (!Array.isArray(keep) || keep.length === 0) {
    throw new InvalidEditError('An order must keep at least one item')
  }

  const seen = new Set<number>()
  const items: StoredPricedLine[] = []

  for (const instruction of keep) {
    const index = Number(instruction?.index)
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      throw new InvalidEditError(`Line ${instruction?.index} is not part of this order`)
    }
    if (seen.has(index)) {
      throw new InvalidEditError(`Line ${index} was listed twice`)
    }
    seen.add(index)

    const stored = lines[index]
    const originalQuantity = num(stored.quantity) || 1
    const nextQuantity = Number(instruction?.quantity)

    if (!Number.isInteger(nextQuantity) || nextQuantity < 1) {
      throw new InvalidEditError(`Quantity for line ${index} must be a whole number of 1 or more`)
    }
    // An edit reduces. Raising a quantity is how an edit would become a way to order more
    // without the stock check, the quantity cap and the payment-method allowlist that
    // POST /api/orders runs — "Order More Items" places a new order for that.
    if (nextQuantity > originalQuantity) {
      throw new InvalidEditError(
        `Quantity for line ${index} cannot be increased from ${originalQuantity} to ${nextQuantity}`,
      )
    }

    if (nextQuantity === originalQuantity) {
      items.push(stored)
      continue
    }

    const unitPrice = unitPriceOf(stored)
    const applied = applyTaxToAmount(round2(unitPrice * nextQuantity), {
      percentage: num(stored.taxRatePercentage),
      is_inclusive: stored.taxInclusive !== false,
    })

    items.push({
      ...stored,
      quantity: nextQuantity,
      unitPrice: round2(unitPrice),
      subtotal: applied.subtotal,
      tax: applied.tax,
      total: applied.total,
    })
  }

  return {
    items,
    subtotal: round2(items.reduce((sum, item) => sum + num(item.subtotal), 0)),
    tax: round2(items.reduce((sum, item) => sum + num(item.tax), 0)),
    total: round2(items.reduce((sum, item) => sum + num(item.total), 0)),
  }
}
