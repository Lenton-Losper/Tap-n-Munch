import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMeasurementUnitLabel, type MeasurementUnitOption } from '@/lib/measurement-units/format'

type MeasurementUnitRow = {
  id: string
  name: string
  symbol: string | null
  is_system: boolean
  restaurant_id: string | null
}

function toOption(row: MeasurementUnitRow): MeasurementUnitOption {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    is_system: row.is_system,
  }
}

export async function getMeasurementUnitsForRestaurant(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<MeasurementUnitOption[]> {
  const [{ data: systemUnits, error: systemError }, { data: customUnits, error: customError }] =
    await Promise.all([
      supabase
        .from('measurement_units')
        .select('id, name, symbol, is_system, restaurant_id')
        .is('restaurant_id', null)
        .eq('is_system', true)
        .order('name'),
      supabase
        .from('measurement_units')
        .select('id, name, symbol, is_system, restaurant_id')
        .eq('restaurant_id', restaurantId)
        .order('name'),
    ])

  if (systemError) throw systemError
  if (customError) throw customError

  const merged = [...(systemUnits ?? []), ...(customUnits ?? [])] as MeasurementUnitRow[]
  return merged.map(toOption).sort((a, b) => a.name.localeCompare(b.name))
}

export function measurementUnitLabelById(
  units: MeasurementUnitOption[],
  unitId: string,
): string {
  const unit = units.find((row) => row.id === unitId)
  return unit ? formatMeasurementUnitLabel(unit) : '—'
}

export async function getSystemMeasurementUnitIdByName(
  supabase: SupabaseClient,
  name: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('measurement_units')
    .select('id')
    .is('restaurant_id', null)
    .eq('name', name)
    .maybeSingle()

  if (error) throw error
  return data?.id ?? null
}
