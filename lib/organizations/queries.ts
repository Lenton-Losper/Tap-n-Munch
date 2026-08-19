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

/**
 * WHICH LOCATIONS MAY THIS USER SEE, and through which client.
 *
 * THE PROBLEM THIS SOLVES. `restaurants` RLS is:
 *
 *     id IN (SELECT public.user_restaurant_ids()) OR owner_id = auth.uid()
 *
 * `organization_id` appears nowhere in it -- there is NO organisation-wide read path on
 * restaurants. So a session-scoped read of an organisation's locations silently returns only the
 * ones the caller personally belongs to. Measured on production 2026-08-19: with two restaurants
 * genuinely in one organisation, the owner's Business tab listed one of them. Not a data problem --
 * the same query with RLS bypassed returned both.
 *
 * lib/stock/transfer-queries.ts already hit this and already solved it the same way, with the same
 * reasoning in its own comment. The Business tab was written with the session client and did not
 * get the treatment.
 *
 * WHY THE ELEVATED READ IS GATED, AND GATED ON EXACTLY THIS. `canViewAllLocations` comes from
 * authorizeOrganization(..., 'view_all_locations'), which is OWNER-only -- the same gate
 * /stock/transfers/all already uses to decide whether a user may see across locations. Widening a
 * read is only safe if something still narrows it; without the gate this would hand every member of
 * any one site a list of every other site in the business.
 *
 * THE CONTROL IS THAT THE FACTORY IS NOT CALLED. For a non-owner this must not merely return fewer
 * rows -- it must never construct the service-role client at all, so there is no path on which RLS
 * was bypassed and the filtering happened somewhere softer. That is what the test asserts, because
 * a check that only counts rows cannot tell "correctly widened" from "authorisation removed".
 */
export async function resolveVisibleLocations(params: {
  organizationId: string
  sessionClient: SupabaseClient
  createAdminClient: () => SupabaseClient
  canViewAllLocations: boolean
}): Promise<OrganizationRestaurantOption[]> {
  const client = params.canViewAllLocations ? params.createAdminClient() : params.sessionClient
  return getOrganizationRestaurants(client, params.organizationId)
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
