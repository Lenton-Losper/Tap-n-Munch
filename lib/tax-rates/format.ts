export type TaxRateOption = {
  id: string
  name: string
  percentage: number
  is_inclusive: boolean
  is_default: boolean
}

export function formatTaxRateLabel(rate: Pick<TaxRateOption, 'name' | 'percentage' | 'is_inclusive'>) {
  const pct = Number(rate.percentage)
  const pctLabel = Number.isFinite(pct) ? `${pct}%` : '—'
  const inclusiveLabel = rate.is_inclusive ? 'incl.' : 'excl.'
  return `${rate.name} (${pctLabel}, ${inclusiveLabel})`
}
