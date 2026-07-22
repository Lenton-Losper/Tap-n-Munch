import type { TaxRateOption } from '@/lib/tax-rates/format'

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Resolve which tax rate applies to a line: its own explicit rate id (if it resolves to a real
 * row), else the restaurant's default rate, else none (0%). Shared by order pricing
 * (lib/orders/calculate-order-pricing.ts) and document line items
 * (lib/documents/create-document.ts) -- one hierarchy, not reimplemented per caller.
 */
export function resolveTaxRate(
  explicitRateId: string | null | undefined,
  ratesById: Map<string, TaxRateOption>,
  fallbackDefault: TaxRateOption | null,
): TaxRateOption | null {
  if (explicitRateId) {
    const explicit = ratesById.get(explicitRateId)
    if (explicit) return explicit
  }
  return fallbackDefault
}

export type AppliedTax = {
  subtotal: number
  tax: number
  total: number
  taxRatePercentage: number
  taxInclusive: boolean
}

/**
 * Splits a raw line amount (quantity * unit price) into subtotal/tax/total for the resolved
 * rate. Inclusive rates keep the charged amount equal to the raw amount and back the VAT
 * portion out of it; exclusive rates treat the raw amount as pre-tax and add VAT on top. No
 * rate (or 0%) charges the raw amount as-is with no tax.
 */
export function applyTaxToAmount(amount: number, rate: TaxRateOption | null): AppliedTax {
  const percentage = rate ? Number(rate.percentage) || 0 : 0
  const isInclusive = rate?.is_inclusive ?? true

  let subtotal: number
  let tax: number
  let total: number

  if (!rate || percentage === 0) {
    total = round2(amount)
    subtotal = total
    tax = 0
  } else if (isInclusive) {
    total = round2(amount)
    tax = round2(total - total / (1 + percentage / 100))
    subtotal = round2(total - tax)
  } else {
    subtotal = round2(amount)
    tax = round2(subtotal * (percentage / 100))
    total = round2(subtotal + tax)
  }

  return { subtotal, tax, total, taxRatePercentage: percentage, taxInclusive: isInclusive }
}
