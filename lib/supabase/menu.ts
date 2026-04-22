import { createServerSupabaseClient } from './server'
import { supabase } from './client'

// CATEGORIES
export async function getSupabaseCategories(restaurantId: string) {
  const { data, error } = await supabase
    .from('menu_categories')
    .select(`
      *,
      menu_subcategories (
        *,
        menu_items (*)
      )
    `)
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .order('display_order')
  if (error) throw error
  return data
}

export async function createSupabaseCategory(data: {
  restaurant_id: string
  name: string
  description?: string
  display_order?: number
}) {
  const supabase = createServerSupabaseClient()
  const { data: category, error } = await supabase
    .from('menu_categories')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return category
}

export async function updateSupabaseCategory(
  categoryId: string,
  updates: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('menu_categories')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', categoryId)
  if (error) throw error
}

export async function deleteSupabaseCategory(categoryId: string) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('menu_categories')
    .update({ active: false })
    .eq('id', categoryId)
  if (error) throw error
}

// SUBCATEGORIES
export async function createSupabaseSubcategory(data: {
  restaurant_id: string
  category_id: string
  name: string
  description?: string
  display_order?: number
}) {
  const supabase = createServerSupabaseClient()
  const { data: sub, error } = await supabase
    .from('menu_subcategories')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return sub
}

// MENU ITEMS
export async function getSupabaseMenuItems(restaurantId: string) {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .order('created_at')
  if (error) throw error
  return data
}

export async function createSupabaseMenuItem(data: {
  restaurant_id: string
  category_id: string
  subcategory_id?: string
  name: string
  description?: string
  base_price: number
  image_url?: string
  variants?: any[]
  variant_groups?: any[]
}) {
  const supabase = createServerSupabaseClient()
  const { data: item, error } = await supabase
    .from('menu_items')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return item
}

export async function updateSupabaseMenuItem(
  itemId: string,
  updates: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('menu_items')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', itemId)
  if (error) throw error
}

export async function deleteSupabaseMenuItem(itemId: string) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('menu_items')
    .update({ status: 'inactive' })
    .eq('id', itemId)
  if (error) throw error
}
