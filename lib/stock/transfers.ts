import { createServerSupabaseClient } from '@/lib/supabase/server'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize, authorizeOrganization } from '@/lib/permissions/authorize'

/**
 * Backend authorization + invocation layer for Workstream 3's transfer functions.
 * No UI wiring here (that's a later workstream) -- this is the boundary that makes the
 * stock:transfer_create/dispatch/receive permissions and authorizeOrganization's
 * create_cross_location_transfer fallback actually enforced, not just available.
 *
 * dispatch_transfer/receive_transfer/create_transfer are service_role-only in the database
 * (see 20260719230000_create_transfer_function.sql) -- calling them directly with a user's
 * own session would bypass every check below entirely, so these wrappers are the only
 * supported way to reach them from application code.
 */

export type TransferItemInput = {
  organizationStockItemId: string
  quantitySent: number
  unitId: string
}

export type CreateTransferInput = {
  userId: string
  organizationId: string
  fromRestaurantId: string
  toRestaurantId: string
  items: TransferItemInput[]
}

export async function createTransfer(
  input: CreateTransferInput,
): Promise<{ data: { transferId: string } } | { error: string }> {
  const { userId, organizationId, fromRestaurantId, toRestaurantId, items } = input

  const canCreateAtSource = await authorize(userId, fromRestaurantId, PERMISSIONS.STOCK_TRANSFER_CREATE)
  if (!canCreateAtSource) {
    const canCreateForOrg = await authorizeOrganization(userId, organizationId, 'create_cross_location_transfer')
    if (!canCreateForOrg) {
      return { error: 'You do not have permission to create a transfer from this restaurant.' }
    }
  }

  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.rpc('create_transfer', {
    p_organization_id: organizationId,
    p_from_restaurant_id: fromRestaurantId,
    p_to_restaurant_id: toRestaurantId,
    p_user_id: userId,
    p_items: items.map((item) => ({
      organization_stock_item_id: item.organizationStockItemId,
      quantity_sent: item.quantitySent,
      unit_id: item.unitId,
    })),
  })

  if (error) {
    return { error: error.message }
  }

  return { data: { transferId: String(data) } }
}

export async function dispatchTransfer(
  userId: string,
  transferId: string,
): Promise<{ data: true } | { error: string }> {
  const supabase = createServerSupabaseClient()

  const { data: transfer, error: transferError } = await supabase
    .from('stock_transfers')
    .select('from_restaurant_id')
    .eq('id', transferId)
    .maybeSingle()

  if (transferError) throw transferError
  if (!transfer) {
    return { error: 'Transfer not found.' }
  }

  const allowed = await authorize(userId, transfer.from_restaurant_id, PERMISSIONS.STOCK_TRANSFER_DISPATCH)
  if (!allowed) {
    return { error: 'You do not have permission to dispatch transfers from this restaurant.' }
  }

  const { error } = await supabase.rpc('dispatch_transfer', {
    p_transfer_id: transferId,
    p_user_id: userId,
  })

  if (error) {
    return { error: error.message }
  }

  return { data: true }
}

export type ReceivedQuantityInput = {
  stockTransferItemId: string
  quantityReceived: number
  varianceReason?: string
}

export async function receiveTransfer(
  userId: string,
  transferId: string,
  receivedQuantities?: ReceivedQuantityInput[],
): Promise<{ data: true } | { error: string }> {
  const supabase = createServerSupabaseClient()

  const { data: transfer, error: transferError } = await supabase
    .from('stock_transfers')
    .select('to_restaurant_id')
    .eq('id', transferId)
    .maybeSingle()

  if (transferError) throw transferError
  if (!transfer) {
    return { error: 'Transfer not found.' }
  }

  const allowed = await authorize(userId, transfer.to_restaurant_id, PERMISSIONS.STOCK_TRANSFER_RECEIVE)
  if (!allowed) {
    return { error: 'You do not have permission to receive transfers at this restaurant.' }
  }

  const { error } = await supabase.rpc('receive_transfer', {
    p_transfer_id: transferId,
    p_user_id: userId,
    p_received_quantities: receivedQuantities?.map((item) => ({
      stock_transfer_item_id: item.stockTransferItemId,
      quantity_received: item.quantityReceived,
      variance_reason: item.varianceReason,
    })),
  })

  if (error) {
    return { error: error.message }
  }

  return { data: true }
}
