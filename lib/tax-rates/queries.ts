import type { SupabaseClient } from '@supabase/supabase-js'
import type { TaxRateOption } from '@/lib/tax-rates/format'

type TaxRateRow = {
  id: string
  name: string
  percentage: number
  is_inclusive: boolean
  is_default: boolean
}

function toOption(row: TaxRateRow): TaxRateOption {
  return {
    id: row.id,
    name: row.name,
    percentage: Number(row.percentage),
    is_inclusive: row.is_inclusive,
    is_default: row.is_default,
  }
}

export async function getTaxRatesForRestaurant(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<TaxRateOption[]> {
  const { data, error } = await supabase
    .from('tax_rates')
    .select('id, name, percentage, is_inclusive, is_default')
    .eq('restaurant_id', restaurantId)
    .order('name')

  if (error) throw error

  return ((data ?? []) as TaxRateRow[]).map(toOption)
}

export function defaultTaxRate(rates: TaxRateOption[]): TaxRateOption | null {
  return rates.find((rate) => rate.is_default) ?? null
}
