export type MeasurementUnitOption = {
  id: string
  name: string
  symbol: string | null
  is_system: boolean
}

export function formatMeasurementUnitLabel(unit: Pick<MeasurementUnitOption, 'name' | 'symbol'>) {
  const symbol = unit.symbol?.trim()
  if (symbol && symbol !== '—') {
    return symbol
  }
  return unit.name
}
