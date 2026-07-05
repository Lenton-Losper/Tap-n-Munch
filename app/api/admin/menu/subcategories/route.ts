import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getRestaurantIdForUser,
  getUserFromRequest,
  resolveRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = (await request.json()) as {
      restaurantId?: string
      categoryId?: string
      name?: string
      description?: string
    }

    const categoryId = String(body?.categoryId || '').trim()
    const name = String(body?.name || '').trim()
    const description = body?.description?.trim() || null

    if (!categoryId || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const callerRestaurantId = await getRestaurantIdForUser(supabase, user.id)

    const denied = await requirePermission(user.id, callerRestaurantId, PERMISSIONS.MENU_WRITE)
    if (denied) return denied

    const bodyRestaurantId = String(body?.restaurantId || '').trim()
    if (bodyRestaurantId) {
      const resolvedBodyRestaurantId = await resolveRestaurantId(supabase, bodyRestaurantId)
      if (resolvedBodyRestaurantId !== callerRestaurantId) {
        return NextResponse.json(
          { error: 'You do not have permission to perform this action.' },
          { status: 403 },
        )
      }
    }

    const { data: category, error: categoryError } = await supabase
      .from('menu_categories')
      .select('id, restaurant_id')
      .eq('id', categoryId)
      .maybeSingle()

    if (categoryError) throw categoryError
    if (!category?.id || String(category.restaurant_id) !== callerRestaurantId) {
      return NextResponse.json(
        { error: 'Category not found for this restaurant' },
        { status: 403 },
      )
    }

    const { data, error } = await supabase
      .from('menu_subcategories')
      .insert({
        restaurant_id: callerRestaurantId,
        category_id: categoryId,
        name,
        description,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create sub-category'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
