import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export type MenuWriteContext = {
  supabase: ReturnType<typeof createServerSupabaseClient>
  restaurantId: string
  userId: string
}

export async function requireMenuWriteContext(
  userId: string,
): Promise<MenuWriteContext | NextResponse> {
  const supabase = createServerSupabaseClient()
  let restaurantId: string
  try {
    restaurantId = await getRestaurantIdForUser(supabase, userId)
  } catch {
    return NextResponse.json(
      { error: 'Restaurant not found for this account.' },
      { status: 403 },
    )
  }

  const denied = await requirePermission(userId, restaurantId, PERMISSIONS.MENU_WRITE)
  if (denied) return denied

  return { supabase, restaurantId, userId }
}

export async function loadCategoryForRestaurant(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  categoryId: string,
  restaurantId: string,
) {
  const { data: category, error } = await supabase
    .from('menu_categories')
    .select('id, restaurant_id')
    .eq('id', categoryId)
    .maybeSingle()

  if (error) throw error
  if (!category?.id || String(category.restaurant_id) !== restaurantId) {
    return null
  }
  return category
}

export async function loadSubcategoryForRestaurant(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  subCategoryId: string,
  restaurantId: string,
) {
  const { data: subcategory, error } = await supabase
    .from('menu_subcategories')
    .select('id, restaurant_id, category_id')
    .eq('id', subCategoryId)
    .maybeSingle()

  if (error) throw error
  if (!subcategory?.id || String(subcategory.restaurant_id) !== restaurantId) {
    return null
  }
  return subcategory
}
