import { createServerSupabaseClient } from './server'
import { supabase } from './client'

export async function getSupabaseTables(restaurantId: string) {
  const { data, error } = await supabase
    .from('restaurant_tables')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
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

export async function deleteSupabaseTable(tableId: string) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('restaurant_tables')
    .update({ active: false })
    .eq('id', tableId)
  if (error) throw error
}
