'use server'

import { revalidatePath } from 'next/cache'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize, authorizeOrganization } from '@/lib/permissions/authorize'
import { getAuthenticatedStockContext } from '@/lib/stock/auth'
import { createTransfer, dispatchTransfer, receiveTransfer, cancelTransfer } from '@/lib/stock/transfers'
import { getOrganizationIdForRestaurant, getTransferWithItems } from '@/lib/stock/transfer-queries'

export type UnconfiguredItemInfo = {
  organizationStockItemId: string
  baseUnitId: string
  baseUnitLabel: string
  itemName: string
  missingAtRestaurantId: string
  missingAtRestaurantName: string
}

async function diagnoseUnconfiguredItems(transferId: string): Promise<UnconfiguredItemInfo[]> {
  const admin = createServerSupabaseClient()
  const detail = await getTransferWithItems(admin, transferId)
  if (!detail) return []

  const [{ data: sourceActive }, { data: destActive }, { data: orgItems }] = await Promise.all([
    admin
      .from('stock_items')
      .select('organization_stock_item_id')
      .eq('restaurant_id', detail.fromRestaurantId)
      .eq('is_active', true),
    admin
      .from('stock_items')
      .select('organization_stock_item_id')
      .eq('restaurant_id', detail.toRestaurantId)
      .eq('is_active', true),
    admin
      .from('organization_stock_items')
      .select('id, base_unit_id')
      .in(
        'id',
        detail.items.map((item) => item.organizationStockItemId),
      ),
  ])

  const sourceSet = new Set((sourceActive ?? []).map((r) => r.organization_stock_item_id as string))
  const destSet = new Set((destActive ?? []).map((r) => r.organization_stock_item_id as string))
  const baseUnitById = new Map((orgItems ?? []).map((r) => [r.id as string, r.base_unit_id as string]))

  const missing: UnconfiguredItemInfo[] = []
  for (const item of detail.items) {
    const baseUnitId = baseUnitById.get(item.organizationStockItemId) ?? item.unitLabel
    if (!sourceSet.has(item.organizationStockItemId)) {
      missing.push({
        organizationStockItemId: item.organizationStockItemId,
        baseUnitId,
        baseUnitLabel: item.unitLabel,
        itemName: item.itemName,
        missingAtRestaurantId: detail.fromRestaurantId,
        missingAtRestaurantName: detail.fromRestaurantName,
      })
    }
    if (!destSet.has(item.organizationStockItemId)) {
      missing.push({
        organizationStockItemId: item.organizationStockItemId,
        baseUnitId,
        baseUnitLabel: item.unitLabel,
        itemName: item.itemName,
        missingAtRestaurantId: detail.toRestaurantId,
        missingAtRestaurantName: detail.toRestaurantName,
      })
    }
  }
  return missing
}

export type CreateTransferItemInput = {
  organizationStockItemId: string
  quantitySent: number
  unitId: string
}

export async function createTransferAction(input: {
  toRestaurantId: string
  items: CreateTransferItemInput[]
}): Promise<{ data: { transferId: string } } | { error: string }> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) return context
  const { userId, restaurantId, supabase } = context

  if (!input.items.length) {
    return { error: 'Add at least one item.' }
  }
  if (input.toRestaurantId === restaurantId) {
    return { error: 'Choose a destination location different from your own.' }
  }

  const organizationId = await getOrganizationIdForRestaurant(supabase, restaurantId)
  if (!organizationId) {
    return { error: 'This restaurant is not linked to an organization.' }
  }

  const result = await createTransfer({
    userId,
    organizationId,
    fromRestaurantId: restaurantId,
    toRestaurantId: input.toRestaurantId,
    items: input.items,
  })

  if ('error' in result) return result

  revalidatePath('/stock/transfers')
  return result
}

export async function dispatchTransferAction(
  transferId: string,
): Promise<{ data: true } | { error: string; unconfiguredItems?: UnconfiguredItemInfo[] }> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) return context
  const { userId } = context

  const result = await dispatchTransfer(userId, transferId)
  if ('error' in result) {
    const unconfiguredItems = await diagnoseUnconfiguredItems(transferId)
    return { error: result.error, unconfiguredItems: unconfiguredItems.length ? unconfiguredItems : undefined }
  }

  revalidatePath('/stock/transfers')
  return result
}

export type ReceivedQuantityInput = {
  stockTransferItemId: string
  quantityReceived: number
  varianceReason?: string
}

export async function receiveTransferAction(
  transferId: string,
  receivedQuantities?: ReceivedQuantityInput[],
): Promise<{ data: true } | { error: string }> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) return context
  const { userId } = context

  const result = await receiveTransfer(userId, transferId, receivedQuantities)
  if ('error' in result) return result

  revalidatePath('/stock/transfers')
  revalidatePath('/stock/transfers/incoming')
  return result
}

export async function cancelTransferAction(transferId: string): Promise<{ data: true } | { error: string }> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) return context
  const { userId } = context

  const result = await cancelTransfer(userId, transferId)
  if ('error' in result) return result

  revalidatePath('/stock/transfers')
  return result
}

export async function configureCanonicalItemAction(input: {
  organizationStockItemId: string
  restaurantId: string
  unitId: string
  name?: string
}): Promise<{ data: { stockItemId: string } } | { error: string }> {
  const context = await getAuthenticatedStockContext()
  if ('error' in context) return context
  const { userId } = context

  const admin = createServerSupabaseClient()

  const { data: orgItem, error: orgItemError } = await admin
    .from('organization_stock_items')
    .select('id, name, organization_id')
    .eq('id', input.organizationStockItemId)
    .maybeSingle()
  if (orgItemError) throw orgItemError
  if (!orgItem) {
    return { error: 'Canonical item not found.' }
  }

  // Same gate as the general "+ Create ingredient" flow (createStockItemAction):
  // stock:receive at the target restaurant. Additionally allows an organization OWNER
  // to configure items at any of their own organization's locations, since they may not
  // hold restaurant-level access everywhere (the whole point of the org-level
  // create_cross_location_transfer fallback on createTransfer).
  const canConfigureLocally = await authorize(userId, input.restaurantId, PERMISSIONS.STOCK_RECEIVE)
  if (!canConfigureLocally) {
    const canConfigureForOrg = await authorizeOrganization(
      userId,
      orgItem.organization_id,
      'create_cross_location_transfer',
    )
    if (!canConfigureForOrg) {
      return { error: 'You do not have permission to configure stock items at this restaurant.' }
    }
  }

  const { data: existing, error: existingError } = await admin
    .from('stock_items')
    .select('id')
    .eq('restaurant_id', input.restaurantId)
    .eq('organization_stock_item_id', input.organizationStockItemId)
    .eq('is_active', true)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing) {
    // Already configured (e.g. a second concurrent attempt) -- idempotent, not an error.
    return { data: { stockItemId: existing.id as string } }
  }

  const { data: created, error: createError } = await admin
    .from('stock_items')
    .insert({
      restaurant_id: input.restaurantId,
      organization_stock_item_id: input.organizationStockItemId,
      name: input.name?.trim() || orgItem.name,
      unit_id: input.unitId,
      is_purchasable: true,
      is_manufactured: false,
      is_active: true,
    })
    .select('id')
    .single()
  if (createError || !created) {
    return { error: createError?.message ?? 'Failed to configure item.' }
  }

  revalidatePath('/stock/transfers')
  revalidatePath('/stock/transfers/new')
  return { data: { stockItemId: created.id as string } }
}
