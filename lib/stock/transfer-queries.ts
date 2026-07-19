import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMeasurementUnitLabel } from '@/lib/measurement-units/format'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize } from '@/lib/permissions/authorize'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/** Gates the Transfers tab: visible if the user holds any one of the three transfer permissions. */
export async function canAccessStockTransfers(userId: string, restaurantId: string): Promise<boolean> {
  const [canCreate, canDispatch, canReceive] = await Promise.all([
    authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_CREATE),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_DISPATCH),
    authorize(userId, restaurantId, PERMISSIONS.STOCK_TRANSFER_RECEIVE),
  ])
  return canCreate || canDispatch || canReceive
}

export type OrganizationRestaurantOption = {
  id: string
  name: string
  locationType: string
}

export type OrganizationStockItemOption = {
  id: string
  name: string
  baseUnitId: string
  baseUnitLabel: string
  isManufactured: boolean
  /** restaurant_ids where this canonical item currently has an active local stock_items mapping. */
  configuredRestaurantIds: string[]
}

export type TransferStatus = 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED'

export type TransferListRow = {
  id: string
  transferNumber: string
  status: TransferStatus
  fromRestaurantId: string
  fromRestaurantName: string
  toRestaurantId: string
  toRestaurantName: string
  createdAt: string
  dispatchedAt: string | null
  receivedAt: string | null
  itemCount: number
}

export type TransferItemRow = {
  id: string
  organizationStockItemId: string
  itemName: string
  unitLabel: string
  quantitySent: number
  quantityReceived: number | null
  varianceReason: string | null
}

export type TransferDetail = TransferListRow & {
  organizationId: string
  items: TransferItemRow[]
}

export async function getOrganizationIdForRestaurant(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('restaurants')
    .select('organization_id')
    .eq('id', restaurantId)
    .maybeSingle()
  if (error) throw error
  return data?.organization_id ?? null
}

export async function getOrganizationRestaurants(
  supabase: SupabaseClient,
  organizationId: string,
  excludeRestaurantId?: string,
): Promise<OrganizationRestaurantOption[]> {
  let query = supabase
    .from('restaurants')
    .select('id, name, location_type')
    .eq('organization_id', organizationId)
    .order('name')

  if (excludeRestaurantId) {
    query = query.neq('id', excludeRestaurantId)
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    locationType: row.location_type as string,
  }))
}

export async function getOrganizationStockItemsWithConfig(
  organizationId: string,
): Promise<OrganizationStockItemOption[]> {
  // Uses the service-role client, not a caller-supplied session client: "is this item
  // configured at the destination" is inherently cross-location information (the caller is
  // very often NOT a restaurant_users member of the destination they're transferring to),
  // and stock_items RLS is scoped strictly to the caller's own restaurant membership with no
  // org-wide read path. A session-scoped read here would silently omit every other
  // location's mapping and make "configured at destination" unable to ever be true for a
  // location the caller doesn't personally belong to -- caught for real running this against
  // staging with two different restaurant managers, not just reasoned about.
  const admin = createServerSupabaseClient()

  const { data: orgItems, error: orgItemsError } = await admin
    .from('organization_stock_items')
    .select('id, name, base_unit_id, is_manufactured, measurement_units(name, symbol)')
    .eq('organization_id', organizationId)
    .order('name')
  if (orgItemsError) throw orgItemsError

  const orgItemIds = (orgItems ?? []).map((item) => item.id as string)
  if (orgItemIds.length === 0) return []

  const { data: localMappings, error: localMappingsError } = await admin
    .from('stock_items')
    .select('organization_stock_item_id, restaurant_id')
    .in('organization_stock_item_id', orgItemIds)
    .eq('is_active', true)
  if (localMappingsError) throw localMappingsError

  const configuredByOrgItem = new Map<string, string[]>()
  for (const row of localMappings ?? []) {
    const key = row.organization_stock_item_id as string
    const list = configuredByOrgItem.get(key) ?? []
    list.push(row.restaurant_id as string)
    configuredByOrgItem.set(key, list)
  }

  return (orgItems ?? []).map((item) => {
    const unitJoin = item.measurement_units as
      | { name: string; symbol: string | null }
      | { name: string; symbol: string | null }[]
      | null
    const unitRow = Array.isArray(unitJoin) ? unitJoin[0] : unitJoin
    return {
      id: item.id as string,
      name: item.name as string,
      baseUnitId: item.base_unit_id as string,
      baseUnitLabel: unitRow ? formatMeasurementUnitLabel(unitRow) : '—',
      isManufactured: Boolean(item.is_manufactured),
      configuredRestaurantIds: configuredByOrgItem.get(item.id as string) ?? [],
    }
  })
}

type RawTransferRow = {
  id: string
  transfer_number: string
  status: TransferStatus
  from_restaurant_id: string
  to_restaurant_id: string
  created_at: string
  dispatched_at: string | null
  received_at: string | null
  organization_id?: string
}

async function attachRestaurantNamesAndCounts(
  supabase: SupabaseClient,
  rows: RawTransferRow[],
): Promise<TransferListRow[]> {
  if (rows.length === 0) return []

  const restaurantIds = [...new Set(rows.flatMap((r) => [r.from_restaurant_id, r.to_restaurant_id]))]
  const transferIds = rows.map((r) => r.id)

  const [{ data: restaurants, error: restaurantsError }, { data: itemCounts, error: itemCountsError }] =
    await Promise.all([
      supabase.from('restaurants').select('id, name').in('id', restaurantIds),
      supabase.from('stock_transfer_items').select('transfer_id').in('transfer_id', transferIds),
    ])
  if (restaurantsError) throw restaurantsError
  if (itemCountsError) throw itemCountsError

  const nameById = new Map((restaurants ?? []).map((r) => [r.id as string, r.name as string]))
  const countByTransfer = new Map<string, number>()
  for (const row of itemCounts ?? []) {
    const key = row.transfer_id as string
    countByTransfer.set(key, (countByTransfer.get(key) ?? 0) + 1)
  }

  return rows.map((row) => ({
    id: row.id,
    transferNumber: row.transfer_number,
    status: row.status,
    fromRestaurantId: row.from_restaurant_id,
    fromRestaurantName: nameById.get(row.from_restaurant_id) ?? 'Unknown location',
    toRestaurantId: row.to_restaurant_id,
    toRestaurantName: nameById.get(row.to_restaurant_id) ?? 'Unknown location',
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    receivedAt: row.received_at,
    itemCount: countByTransfer.get(row.id) ?? 0,
  }))
}

export async function getOutgoingTransfers(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<TransferListRow[]> {
  const { data, error } = await supabase
    .from('stock_transfers')
    .select('id, transfer_number, status, from_restaurant_id, to_restaurant_id, created_at, dispatched_at, received_at')
    .eq('from_restaurant_id', restaurantId)
    .in('status', ['DRAFT', 'IN_TRANSIT'])
    .order('created_at', { ascending: false })
  if (error) throw error
  return attachRestaurantNamesAndCounts(supabase, (data ?? []) as RawTransferRow[])
}

export async function getIncomingTransfers(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<TransferListRow[]> {
  const { data, error } = await supabase
    .from('stock_transfers')
    .select('id, transfer_number, status, from_restaurant_id, to_restaurant_id, created_at, dispatched_at, received_at')
    .eq('to_restaurant_id', restaurantId)
    .eq('status', 'IN_TRANSIT')
    .order('dispatched_at', { ascending: false })
  if (error) throw error
  return attachRestaurantNamesAndCounts(supabase, (data ?? []) as RawTransferRow[])
}

export async function getIncomingTransfersDetailed(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<TransferDetail[]> {
  const list = await getIncomingTransfers(supabase, restaurantId)
  const details = await Promise.all(list.map((row) => getTransferWithItems(supabase, row.id)))
  return details.filter((detail): detail is TransferDetail => detail !== null)
}

export type TransferHistoryFilters = {
  dateRangeStart?: string | null
  organizationStockItemId?: string
}

export async function getTransferHistory(
  supabase: SupabaseClient,
  restaurantId: string,
  filters: TransferHistoryFilters = {},
): Promise<TransferListRow[]> {
  let query = supabase
    .from('stock_transfers')
    .select('id, transfer_number, status, from_restaurant_id, to_restaurant_id, created_at, dispatched_at, received_at')
    .in('status', ['RECEIVED', 'CANCELLED'])
    .or(`from_restaurant_id.eq.${restaurantId},to_restaurant_id.eq.${restaurantId}`)
    .order('created_at', { ascending: false })

  if (filters.dateRangeStart) {
    query = query.gte('created_at', filters.dateRangeStart)
  }

  const { data, error } = await query
  if (error) throw error

  let rows = (data ?? []) as RawTransferRow[]

  if (filters.organizationStockItemId) {
    const { data: matchingItems, error: matchingItemsError } = await supabase
      .from('stock_transfer_items')
      .select('transfer_id')
      .eq('organization_stock_item_id', filters.organizationStockItemId)
    if (matchingItemsError) throw matchingItemsError
    const matchingTransferIds = new Set((matchingItems ?? []).map((r) => r.transfer_id as string))
    rows = rows.filter((row) => matchingTransferIds.has(row.id))
  }

  return attachRestaurantNamesAndCounts(supabase, rows)
}

export async function getAllOrganizationTransfers(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<TransferListRow[]> {
  const { data, error } = await supabase
    .from('stock_transfers')
    .select('id, transfer_number, status, from_restaurant_id, to_restaurant_id, created_at, dispatched_at, received_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return attachRestaurantNamesAndCounts(supabase, (data ?? []) as RawTransferRow[])
}

export async function getTransferWithItems(
  supabase: SupabaseClient,
  transferId: string,
): Promise<TransferDetail | null> {
  const { data: transfer, error: transferError } = await supabase
    .from('stock_transfers')
    .select('id, organization_id, transfer_number, status, from_restaurant_id, to_restaurant_id, created_at, dispatched_at, received_at')
    .eq('id', transferId)
    .maybeSingle()
  if (transferError) throw transferError
  if (!transfer) return null

  const [{ data: items, error: itemsError }, [listRow]] = await Promise.all([
    supabase
      .from('stock_transfer_items')
      .select('id, organization_stock_item_id, quantity_sent, quantity_received, variance_reason, unit_id, organization_stock_items(name), measurement_units(name, symbol)')
      .eq('transfer_id', transferId),
    attachRestaurantNamesAndCounts(supabase, [transfer as RawTransferRow]),
  ])
  if (itemsError) throw itemsError

  const itemRows: TransferItemRow[] = (items ?? []).map((row) => {
    const nameJoin = row.organization_stock_items as { name: string } | { name: string }[] | null
    const nameRow = Array.isArray(nameJoin) ? nameJoin[0] : nameJoin
    const unitJoin = row.measurement_units as
      | { name: string; symbol: string | null }
      | { name: string; symbol: string | null }[]
      | null
    const unitRow = Array.isArray(unitJoin) ? unitJoin[0] : unitJoin
    return {
      id: row.id as string,
      organizationStockItemId: row.organization_stock_item_id as string,
      itemName: nameRow?.name ?? 'Unknown item',
      unitLabel: unitRow ? formatMeasurementUnitLabel(unitRow) : '—',
      quantitySent: Number(row.quantity_sent),
      quantityReceived: row.quantity_received == null ? null : Number(row.quantity_received),
      varianceReason: row.variance_reason as string | null,
    }
  })

  return {
    ...listRow,
    organizationId: transfer.organization_id as string,
    items: itemRows,
  }
}
