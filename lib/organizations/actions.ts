'use server'

import { revalidatePath } from 'next/cache'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { authorizeOrganization } from '@/lib/permissions/authorize'
import { getAuthenticatedSettingsContext } from '@/lib/settings/auth'
import { buildDefaultRestaurantRolesSeed } from '@/lib/auth/create-restaurant'
import {
  getOrganizationIdForRestaurant,
  resolveVisibleLocations,
  type OrganizationRestaurantOption,
} from '@/lib/organizations/queries'

/**
 * Backend authorization + invocation layer for Business & Locations, mirroring
 * lib/stock/transfer-actions.ts: session resolution + authorizeOrganization happen here,
 * then the actual write goes through the service-role client to the SECURITY DEFINER
 * create_organization_location function (service_role-only in the database), so a client
 * can't call the RPC directly and skip the permission check.
 */

export type LocationsPageData = {
  organizationId: string
  canCreateLocation: boolean
  locations: OrganizationRestaurantOption[]
}

export async function getLocationsPageDataAction(): Promise<
  { data: LocationsPageData } | { error: string }
> {
  const context = await getAuthenticatedSettingsContext()
  if ('error' in context) return context
  const { userId, restaurantId, supabase } = context

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)
  if (!organizationId) {
    return { error: 'This restaurant is not linked to a business.' }
  }

  // Two separate questions, deliberately not collapsed into one call even though
  // authorizeOrganization grants every capability to an OWNER today: "may I add a location" and
  // "may I see the other locations" are different permissions, and a future non-owner org role
  // (MEMBER is already a placeholder) will answer them differently.
  const [canCreateLocation, canViewAllLocations] = await Promise.all([
    authorizeOrganization(userId, organizationId, 'create_location'),
    authorizeOrganization(userId, organizationId, 'view_all_locations'),
  ])

  // The elevated read happens ONLY behind canViewAllLocations -- see resolveVisibleLocations for
  // why a session-scoped read cannot answer this question at all.
  const locations = await resolveVisibleLocations({
    organizationId,
    sessionClient: supabase,
    createAdminClient: createServerSupabaseClient,
    canViewAllLocations,
  })

  return { data: { organizationId, canCreateLocation, locations } }
}

export type CreateLocationInput = {
  name: string
  address?: string
  copyStockConfigFromRestaurantId?: string
}

export async function createLocationAction(
  input: CreateLocationInput,
): Promise<{ data: { restaurantId: string } } | { error: string }> {
  const context = await getAuthenticatedSettingsContext()
  if ('error' in context) return context
  const { userId, restaurantId, supabase } = context

  const name = input.name.trim()
  if (!name) {
    return { error: 'Location name is required.' }
  }

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)
  if (!organizationId) {
    return { error: 'This restaurant is not linked to a business.' }
  }

  const canCreate = await authorizeOrganization(userId, organizationId, 'create_location')
  if (!canCreate) {
    return { error: 'You do not have permission to add a location.' }
  }

  const admin = createServerSupabaseClient()
  // Same helper signup uses (buildDefaultRestaurantRolesSeed -> role-permissions.config.json)
  // -- not a second, hand-written role list.
  const rolesSeed = buildDefaultRestaurantRolesSeed()

  const { data: newRestaurantId, error } = await admin.rpc('create_organization_location', {
    p_organization_id: organizationId,
    p_created_by_user_id: userId,
    p_name: name,
    p_address: input.address?.trim() || null,
    p_roles: rolesSeed,
    p_copy_stock_config_from_restaurant_id: input.copyStockConfigFromRestaurantId || null,
  })

  if (error || !newRestaurantId) {
    return { error: error?.message ?? 'Failed to create location.' }
  }

  revalidatePath('/settings')
  return { data: { restaurantId: String(newRestaurantId) } }
}
