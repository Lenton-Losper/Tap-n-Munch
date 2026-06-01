import { createServerSupabaseClient } from './server'
import { supabase } from './client'
import { resolveRestaurantUuid } from './restaurants'

export async function getSupabaseTables(restaurantId: string, isFirebaseId = false) {
  const resolvedRestaurantId = isFirebaseId
    ? await resolveRestaurantUuid(restaurantId)
    : restaurantId
  const { data, error } = await supabase
    .from('restaurant_tables')
    .select('*')
    .eq('restaurant_id', resolvedRestaurantId)
    .order('table_number')
  if (error) throw error
  return data
}

export async function createSupabaseTable(data: {
  restaurant_id: string
  table_number: number
  table_name?: string
  qr_code_url?: string
}) {
  const supabase = createServerSupabaseClient()
  const { data: table, error } = await supabase
    .from('restaurant_tables')
    .insert(data)
    .select()
    .single()
  if (error) throw error
  return table
}

export async function updateSupabaseTable(
  tableId: string,
  updates: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('restaurant_tables')
    .update(updates)
    .eq('id', tableId)
  if (error) throw error
}

export async function deleteSupabaseTable(
  tableId: string,
  options: { restaurantId: string; accessToken: string }
) {
  const res = await fetch(`/api/admin/tables/${encodeURIComponent(tableId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ restaurantId: options.restaurantId }),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(payload?.error || `Failed to delete table (${res.status})`)
  }
}

export async function getSupabaseTableByNumber(
  restaurantId: string,
  tableNumber: number,
  isFirebaseId = false
) {
  const resolvedRestaurantId = isFirebaseId
    ? await resolveRestaurantUuid(restaurantId)
    : restaurantId

  const { data, error } = await supabase
    .from('restaurant_tables')
    .select('*')
    .eq('restaurant_id', resolvedRestaurantId)
    .eq('table_number', tableNumber)
    .single()

  if (error) throw error
  return data
}
