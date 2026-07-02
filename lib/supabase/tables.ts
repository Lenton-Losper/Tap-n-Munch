import { supabase } from './client'
import type { OrderingPointRow } from '@/lib/tables/ordering-points'

export async function getSupabaseTables(
  restaurantId: string,
  isFirebaseId = false,
  options: { includeInactive?: boolean } = {},
) {
  const { resolveRestaurantUuid } = await import('./restaurants')
  const resolvedRestaurantId = isFirebaseId
    ? await resolveRestaurantUuid(restaurantId)
    : restaurantId

  let query = supabase
    .from('restaurant_tables')
    .select('*')
    .eq('restaurant_id', resolvedRestaurantId)
    .order('table_number')

  if (!options.includeInactive) {
    query = query.eq('active', true)
  }

  const { data, error } = await query
  if (error) throw error
  return data as OrderingPointRow[]
}

export async function createOrderingPointViaApi(
  body: Record<string, unknown>,
  options: { restaurantId: string; accessToken: string },
) {
  const res = await fetch('/api/admin/tables', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(payload?.error || `Failed to create (${res.status})`)
  }
  return payload.table as OrderingPointRow
}

export async function updateOrderingPointViaApi(
  tableId: string,
  body: Record<string, unknown>,
  options: { restaurantId: string; accessToken: string },
) {
  const res = await fetch(`/api/admin/tables/${encodeURIComponent(tableId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, restaurantId: options.restaurantId }),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(payload?.error || `Failed to update (${res.status})`)
  }
  return payload.table as OrderingPointRow
}

/** @deprecated Use createOrderingPointViaApi */
export async function createSupabaseTable(_data: {
  restaurant_id: string
  table_number: number
  table_name?: string
  qr_code_url?: string
}) {
  throw new Error('createSupabaseTable is deprecated — use createOrderingPointViaApi')
}

export async function updateSupabaseTable(
  tableId: string,
  updates: Record<string, unknown>,
) {
  const { createServerSupabaseClient } = await import('./server')
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('restaurant_tables')
    .update(updates)
    .eq('id', tableId)
  if (error) throw error
}

export async function deleteSupabaseTable(
  tableId: string,
  options: { restaurantId: string; accessToken: string },
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
  isFirebaseId = false,
  options: { includeInactive?: boolean } = {},
) {
  const { resolveRestaurantUuid } = await import('./restaurants')
  const resolvedRestaurantId = isFirebaseId
    ? await resolveRestaurantUuid(restaurantId)
    : restaurantId

  let query = supabase
    .from('restaurant_tables')
    .select('*')
    .eq('restaurant_id', resolvedRestaurantId)
    .eq('table_number', tableNumber)

  if (!options.includeInactive) {
    query = query.eq('active', true)
  }

  const { data, error } = await query.single()

  if (error) throw error
  return data as OrderingPointRow
}
