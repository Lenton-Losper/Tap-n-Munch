import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared organization/location queries. Originally lived in lib/stock/transfer-queries.ts
 * (Workstream 4); moved here because Business & Locations needs the exact same "which
 * restaurant belongs to which org" and "list an org's restaurants" queries -- re-exported
 * from transfer-queries.ts so existing Transfer UI imports are unaffected.
 */

export type OrganizationRestaurantOption = {
  id: string
  name: string
  locationType: string
  address: string | null
}

export async function getOrganizationIdForRestaurant(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('restaurants')
    .select('organization_id')
    .eq('id', restaurantId)
    .maybeSingle()
  if (error) throw error
  return data?.organization_id ?? null
}

export async function getOrganizationRestaurants(
  supabase: SupabaseClient,
  organizationId: string,
  excludeRestaurantId?: string,
): Promise<OrganizationRestaurantOption[]> {
  let query = supabase
    .from('restaurants')
    .select('id, name, location_type, address')
    .eq('organization_id', organizationId)
    .order('name')

  if (excludeRestaurantId) {
    query = query.neq('id', excludeRestaurantId)
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    locationType: row.location_type as string,
    address: (row.address as string | null) ?? null,
  }))
}
