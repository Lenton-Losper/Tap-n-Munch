import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { normalizePermissionsInput } from '@/lib/restaurant-roles/utils'
import { countRoleAssignments } from '@/lib/restaurant-roles/assignments'

export const dynamic = 'force-dynamic'

function errorStatus(message: string): number {
  if (message.includes('authorization') || message.includes('session')) return 401
  if (message.includes('permission')) return 403
  return 500
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ roleSlug: string }> },
) {
  try {
    const { roleSlug } = await params
    const slug = decodeURIComponent(roleSlug || '').trim()
    if (!slug) {
      return NextResponse.json({ error: 'Missing role slug' }, { status: 400 })
    }

    const user = await getUserFromRequest(request)
    const body = await request.json()
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const { data: existing, error: fetchError } = await supabase
      .from('restaurant_roles')
      .select('id, role_slug, is_system')
      .eq('restaurant_id', restaurantId)
      .eq('role_slug', slug)
      .maybeSingle()

    if (fetchError) throw fetchError
    if (!existing) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 })
    }
    if (existing.is_system) {
      return NextResponse.json({ error: 'System roles cannot be modified' }, { status: 403 })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body?.display_name !== undefined) {
      const displayName = String(body.display_name).trim()
      if (!displayName) {
        return NextResponse.json({ error: 'display_name cannot be empty' }, { status: 400 })
      }
      updates.display_name = displayName
    }
    if (body?.permissions !== undefined) {
      const permissions = normalizePermissionsInput(body.permissions)
      if (permissions === null) {
        return NextResponse.json({ error: 'Invalid permissions array' }, { status: 400 })
      }
      updates.permissions = permissions
    }
    if (body?.is_invite_eligible !== undefined) {
      updates.is_invite_eligible = body.is_invite_eligible === true
    }

    if (Object.keys(updates).length === 1) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('restaurant_roles')
      .update(updates)
      .eq('id', existing.id)
      .select(
        'id, role_slug, display_name, permissions, is_system, is_invite_eligible, created_at, updated_at',
      )
      .single()

    if (error) throw error
    return NextResponse.json({ role: data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update role'
    return NextResponse.json({ error: message }, { status: errorStatus(message) })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ roleSlug: string }> },
) {
  try {
    const { roleSlug } = await params
    const slug = decodeURIComponent(roleSlug || '').trim()
    if (!slug) {
      return NextResponse.json({ error: 'Missing role slug' }, { status: 400 })
    }

    const user = await getUserFromRequest(_request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const { data: existing, error: fetchError } = await supabase
      .from('restaurant_roles')
      .select('id, role_slug, is_system')
      .eq('restaurant_id', restaurantId)
      .eq('role_slug', slug)
      .maybeSingle()

    if (fetchError) throw fetchError
    if (!existing) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 })
    }
    if (existing.is_system) {
      return NextResponse.json({ error: 'System roles cannot be deleted' }, { status: 403 })
    }

    const assignmentCount = await countRoleAssignments(supabase, restaurantId, slug)
    if (assignmentCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete role: ${assignmentCount} staff member${assignmentCount === 1 ? '' : 's'} are currently assigned. Reassign them first.`,
        },
        { status: 409 },
      )
    }

    const { error: deleteError } = await supabase
      .from('restaurant_roles')
      .delete()
      .eq('id', existing.id)

    if (deleteError) throw deleteError
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete role'
    return NextResponse.json({ error: message }, { status: errorStatus(message) })
  }
}
