import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Attach restaurants(name)-shaped embeds without relying on a PostgREST FK.
 * Staging bug_reports historically lacked restaurant_id → restaurants.
 */
export async function attachRestaurantNames(
  supabase: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  restaurantIdKey = 'restaurant_id',
): Promise<Array<Record<string, unknown> & { restaurants: { name: string } | null }>> {
  const ids = [
    ...new Set(
      rows
        .map((row) => row[restaurantIdKey])
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]

  const nameById = new Map<string, string>()
  if (ids.length > 0) {
    const { data, error } = await supabase.from('restaurants').select('id, name').in('id', ids)
    if (error) throw error
    for (const restaurant of data ?? []) {
      nameById.set(String(restaurant.id), String(restaurant.name ?? ''))
    }
  }

  return rows.map((row) => {
    const restaurantId = row[restaurantIdKey]
    const name =
      typeof restaurantId === 'string' && restaurantId
        ? nameById.get(restaurantId) || null
        : null
    return {
      ...row,
      restaurants: name ? { name } : null,
    }
  })
}
