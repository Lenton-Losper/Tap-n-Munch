// @ts-nocheck
import { createServerSupabaseClient } from './server'
import { supabase } from './client'
import { resolveRestaurantUuid } from './restaurants'
import { buildMenuItemDbPayload } from '@/lib/menu-item-db-payload'

/** Map Supabase column names to fields expected by menu-management UI. */
export function normalizeMenuItemForClient(row: Record<string, any>) {
  if (!row) return row
  return {
    ...row,
    menu_category_id: row.menu_category_id ?? row.category_id ?? null,
    sub_category_id: row.sub_category_id ?? row.subcategory_id ?? null,
    base_price: Number(row.base_price ?? 0),
    imageFit: row.image_fit ?? row.imageFit ?? 'contain',
    imagePosition: row.image_position ?? row.imagePosition ?? 'center',
    allow_special_instructions: row.allow_special_instructions ?? true,
    has_sizes: row.has_sizes ?? false,
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    has_addons: row.has_addons ?? false,
    addons: Array.isArray(row.addons) ? row.addons : [],
    variantGroups: row.variant_groups ?? row.variantGroups ?? [],
  }
}

export function normalizeSubCategoryForClient(row: Record<string, any>) {
  if (!row) return row
  return {
    ...row,
    menu_category_id: row.menu_category_id ?? row.category_id ?? null,
  }
}

// CATEGORIES
export async function getSupabaseCategories(restaurantId: string, isFirebaseId = false) {
  const resolvedRestaurantId = isFirebaseId
    ? await resolveRestaurantUuid(restaurantId)
    : restaurantId

  const { data, error } = await supabase
    .from('menu_categories')
    .select(`
      *,
      menu_subcategories (
        *,
        menu_items (*)
      )
    `)
    .eq('restaurant_id', resolvedRestaurantId)
    .order('display_order')
  if (error) throw error
  return data
}

export async function createSupabaseCategory(data: {
  restaurant_id: string
  name: string
  description?: string
  display_order?: number
  route_to?: 'kitchen' | 'bar' | 'both'
}) {
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
  const { error } = await supabase
    .from('menu_categories')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', categoryId)
  if (error) throw error
}

export async function deleteSupabaseCategory(categoryId: string) {
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
  const resolvedRestaurantId = await resolveRestaurantUuid(restaurantId)
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('restaurant_id', resolvedRestaurantId)
    .order('name')
  if (error) throw error
  return (data || []).filter(isCustomerMenuItemVisible)
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
  const { error } = await supabase
    .from('menu_items')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', itemId)
  if (error) throw error
}

export async function deleteSupabaseMenuItem(itemId: string) {
  const { error } = await supabase
    .from('menu_items')
    .update({ status: 'hidden', updated_at: new Date().toISOString() })
    .eq('id', itemId)
  if (error) throw error
}

function isCustomerMenuItemVisible(item: Record<string, any>) {
  const status = String(item.status || 'available').toLowerCase()
  return status !== 'hidden'
}

function normalizeCustomerMenuItem(item: Record<string, any>) {
  return {
    ...item,
    base_price: Number(item.base_price ?? 0),
    status: item.status || 'available',
  }
}

export async function getSupabaseMenuItemsByCategory(
  restaurantId: string,
  categoryId: string,
  isFirebaseId = false
) {
  const resolvedRestaurantId = isFirebaseId
    ? await resolveRestaurantUuid(restaurantId)
    : restaurantId

  const [{ data: subcategories, error: subError }, { data: categoryItems, error: itemsError }] =
    await Promise.all([
      supabase
        .from('menu_subcategories')
        .select('id, name, display_order')
        .eq('restaurant_id', resolvedRestaurantId)
        .eq('category_id', categoryId)
        .order('display_order'),
      supabase
        .from('menu_items')
        .select('*')
        .eq('restaurant_id', resolvedRestaurantId)
        .eq('category_id', categoryId)
        .order('name'),
    ])

  if (subError) throw subError
  if (itemsError) throw itemsError

  const visibleItems = (categoryItems || [])
    .filter(isCustomerMenuItemVisible)
    .map(normalizeCustomerMenuItem)

  const grouped: Record<string, { subcategory: any; items: any[] }> = {}
  const subcategoryIds = new Set<string>()

  for (const subcategory of subcategories || []) {
    subcategoryIds.add(subcategory.id)
    const items = visibleItems.filter((item) => item.subcategory_id === subcategory.id)
    if (items.length === 0) continue
    grouped[subcategory.id] = {
      subcategory: {
        id: subcategory.id,
        name: subcategory.name,
        display_order: subcategory.display_order,
      },
      items,
    }
  }

  const uncategorizedItems = visibleItems.filter(
    (item) => !item.subcategory_id || !subcategoryIds.has(item.subcategory_id)
  )
  if (uncategorizedItems.length > 0) {
    grouped.__category_items__ = {
      subcategory: {
        id: '__category_items__',
        name: 'Menu',
        display_order: 0,
      },
      items: uncategorizedItems,
    }
  }

  return grouped
}

export async function getSupabaseMenuItemById(
  menuItemId: string,
  restaurantId?: string,
  isFirebaseId = false
) {
  let query = supabase.from('menu_items').select('*').eq('id', menuItemId)
  if (restaurantId) {
    const resolvedRestaurantId = isFirebaseId
      ? await resolveRestaurantUuid(restaurantId)
      : restaurantId
    query = query.eq('restaurant_id', resolvedRestaurantId)
  }
  const { data, error } = await query.single()
  if (error) throw error
  return data
}

export type MenuCategory = Record<string, any>
export type SubCategory = Record<string, any>
export type MenuItem = Record<string, any> & {
  base_price: number
}
export type Category = Record<string, any>

export async function getMenuCategories(firebaseRestaurantId: string) {
  return getSupabaseCategories(firebaseRestaurantId, true)
}

export async function createMenuCategory(
  firebaseRestaurantId: string,
  name: string,
  description?: string,
  routeTo?: 'kitchen' | 'bar' | 'both'
) {
  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  return createSupabaseCategory({
    restaurant_id: restaurantId,
    name,
    description,
    route_to: routeTo || 'kitchen',
  })
}

export async function updateMenuCategory(
  firebaseRestaurantId: string,
  categoryId: string,
  updates: Record<string, any>
) {
  await resolveRestaurantUuid(firebaseRestaurantId)
  return updateSupabaseCategory(categoryId, updates)
}

export async function getSubCategories(firebaseRestaurantId: string, categoryId: string) {
  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  const { data, error } = await supabase
    .from('menu_subcategories')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('category_id', categoryId)
    .order('display_order')
  if (error) {
    const status = (error as any)?.code || ''
    const message = String((error as any)?.message || '')
    // Some deployments still miss anon SELECT policy on menu_subcategories.
    // Return empty instead of hard-failing the whole client flow.
    if (status === '42501' || message.toLowerCase().includes('permission denied')) {
      console.warn('menu_subcategories read blocked by RLS; returning empty list')
      return []
    }
    throw error
  }
  return (data || []).map(normalizeSubCategoryForClient)
}

export async function createSubCategory(
  firebaseRestaurantId: string,
  categoryId: string,
  name: string,
  description?: string
) {
  if (typeof window !== 'undefined') {
    const response = await fetch('/api/admin/menu/subcategories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId: firebaseRestaurantId, categoryId, name, description }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error || 'Failed to create sub-category')
    return payload?.data
  }

  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  return createSupabaseSubcategory({ restaurant_id: restaurantId, category_id: categoryId, name, description })
}

export async function updateSubCategory(
  firebaseRestaurantId: string,
  categoryId: string,
  subCategoryId: string,
  updates: Record<string, any>
) {
  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  const { error } = await supabase
    .from('menu_subcategories')
    .update({ ...updates, category_id: categoryId, restaurant_id: restaurantId })
    .eq('id', subCategoryId)
  if (error) throw error
}

export async function getMenuItems(firebaseRestaurantId: string, subCategoryId?: string) {
  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  let query = supabase.from('menu_items').select('*').eq('restaurant_id', restaurantId).order('name')
  void subCategoryId
  const { data, error } = await query
  if (error) throw error
  return (data || []).map(normalizeMenuItemForClient)
}

export async function createMenuItem(data: Record<string, any>) {
  if (typeof window !== 'undefined') {
    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      throw new Error('You must be signed in to create menu items.')
    }

    const response = await fetch('/api/admin/menu/items', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(data),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error || 'Failed to create menu item')
    return payload?.id
  }

  const payload = {
    ...data,
    base_price: Number(data.base_price ?? 0),
    subcategory_id: (data.sub_category_id ?? data.subcategory_id) || null,
    status: data.status || 'available',
  }
  delete payload.sub_category_id
  const { data: row, error } = await supabase.from('menu_items').insert(payload).select().single()
  if (error) throw error
  return row?.id
}

export async function updateMenuItem(
  firebaseRestaurantId: string,
  categoryId: string,
  subCategoryId: string,
  itemId: string,
  data: Record<string, any>
) {
  if (typeof window !== 'undefined') {
    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      throw new Error('You must be signed in to update menu items.')
    }

    const response = await fetch('/api/admin/menu/items', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        id: itemId,
        restaurant_id: firebaseRestaurantId,
        category_id: categoryId,
        subcategory_id: subCategoryId || null,
        ...data,
      }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to update menu item')
    }
    return
  }

  const payload = buildMenuItemDbPayload({
    ...data,
    category_id: categoryId,
    subcategory_id: subCategoryId || null,
  })
  payload.updated_at = new Date().toISOString()
  const { error } = await supabase.from('menu_items').update(payload).eq('id', itemId)
  if (error) throw error
}

export async function deleteMenuItem(
  firebaseRestaurantId: string,
  _categoryId: string,
  _subCategoryId: string,
  itemId: string
) {
  if (typeof window !== 'undefined') {
    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      throw new Error('You must be signed in to delete menu items.')
    }

    const response = await fetch('/api/admin/menu/items', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        id: itemId,
        restaurant_id: firebaseRestaurantId,
      }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to delete menu item')
    }
    return
  }

  return deleteSupabaseMenuItem(itemId)
}

export async function deleteMenuCategoryCascade(firebaseRestaurantId: string, categoryId: string) {
  const restaurantId = await resolveRestaurantUuid(firebaseRestaurantId)
  const { data: subcats, error: subErr } = await supabase
    .from('menu_subcategories')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('category_id', categoryId)
  if (subErr) throw subErr

  const subIds = (subcats || []).map((s: any) => s.id)
  if (subIds.length > 0) {
    const { error: itemErr } = await supabase.from('menu_items').delete().in('subcategory_id', subIds)
    if (itemErr) throw itemErr
    const { error: subDelErr } = await supabase.from('menu_subcategories').delete().in('id', subIds)
    if (subDelErr) throw subDelErr
  }
  const { error: catErr } = await supabase.from('menu_categories').delete().eq('id', categoryId)
  if (catErr) throw catErr
}

export async function deleteSubCategoryCascade(
  firebaseRestaurantId: string,
  _categoryId: string,
  subCategoryId: string
) {
  await resolveRestaurantUuid(firebaseRestaurantId)
  const { error: itemErr } = await supabase.from('menu_items').delete().eq('subcategory_id', subCategoryId)
  if (itemErr) throw itemErr
  const { error: subErr } = await supabase.from('menu_subcategories').delete().eq('id', subCategoryId)
  if (subErr) throw subErr
}

// Legacy category API compatibility
export async function getCategories(firebaseRestaurantId: string) {
  return getMenuCategories(firebaseRestaurantId)
}

export async function createCategory(firebaseRestaurantId: string, name: string) {
  return createMenuCategory(firebaseRestaurantId, name)
}

export async function createDefaultCategories(firebaseRestaurantId: string) {
  const defaults = ['Starters', 'Mains', 'Drinks']
  for (const name of defaults) {
    await createMenuCategory(firebaseRestaurantId, name)
  }
}

export async function deleteCategory(firebaseRestaurantId: string, categoryId: string) {
  return deleteMenuCategoryCascade(firebaseRestaurantId, categoryId)
}

export async function deleteAllCategories(firebaseRestaurantId: string) {
  const categories = await getMenuCategories(firebaseRestaurantId)
  for (const category of categories) {
    await deleteMenuCategoryCascade(firebaseRestaurantId, String(category.id))
  }
}

export async function removeDuplicateCategories(_firebaseRestaurantId: string) {
  return { removed: 0, duplicates: [] as any[] }
}

export async function removeDuplicateMenuItems(_firebaseRestaurantId: string) {
  return { removed: 0, duplicates: [] as any[] }
}
