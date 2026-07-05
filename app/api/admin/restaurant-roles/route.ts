import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import {
  ensureUniqueRoleSlug,
  normalizePermissionsInput,
  slugifyRoleDisplayName,
} from '@/lib/restaurant-roles/utils'
import { getAssignmentCountsByRole } from '@/lib/restaurant-roles/assignments'

export const dynamic = 'force-dynamic'

function errorStatus(message: string): number {
  if (message.includes('authorization') || message.includes('session')) return 401
  if (message.includes('permission')) return 403
  return 500
}

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_roles')
      .select(
        'id, role_slug, display_name, permissions, is_system, is_invite_eligible, created_at, updated_at',
      )
      .eq('restaurant_id', restaurantId)
      .order('is_system', { ascending: false })
      .order('display_name', { ascending: true })

    if (error) throw error

    const assignmentCounts = await getAssignmentCountsByRole(supabase, restaurantId)
    const roles = (data ?? []).map((role) => ({
      ...role,
      assigned_count: assignmentCounts[role.role_slug] ?? 0,
    }))

    return NextResponse.json({ roles })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list roles'
    return NextResponse.json({ error: message }, { status: errorStatus(message) })
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const displayName = String(body?.display_name || '').trim()
    const requestedSlug = String(body?.role_slug || '').trim()
    const permissions = normalizePermissionsInput(body?.permissions)

    if (!displayName) {
      return NextResponse.json({ error: 'display_name is required' }, { status: 400 })
    }
    if (permissions === null) {
      return NextResponse.json({ error: 'Invalid permissions array' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const baseSlug = requestedSlug || slugifyRoleDisplayName(displayName)
    if (!/^[a-z][a-z0-9_]*$/.test(baseSlug)) {
      return NextResponse.json({ error: 'Invalid role_slug format' }, { status: 400 })
    }

    const roleSlug = await ensureUniqueRoleSlug(supabase, restaurantId, baseSlug)
    const isInviteEligible = body?.is_invite_eligible === true

    const { data, error } = await supabase
      .from('restaurant_roles')
      .insert({
        restaurant_id: restaurantId,
        role_slug: roleSlug,
        display_name: displayName,
        permissions,
        is_system: false,
        is_invite_eligible: isInviteEligible,
      })
      .select('id, role_slug, display_name, permissions, is_system, is_invite_eligible, created_at, updated_at')
      .single()

    if (error) throw error
    return NextResponse.json({ role: data }, { status: 201 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create role'
    return NextResponse.json({ error: message }, { status: errorStatus(message) })
  }
}
