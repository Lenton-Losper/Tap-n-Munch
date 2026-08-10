import { supabase } from './client'
import { resolveOrderRestaurantScope, type OrderRestaurantScope } from './restaurants'

/**
 * Every value order_requests.status can hold.
 *
 * Enforced in the database, not inferred from call sites: 20260726100000_order_requests.sql
 * created the column with CHECK (status IN ('waiting_review','accepted','declined')) and
 * 20260726120000_order_requests_accepting_status.sql widened it to add 'accepting', the
 * transient state Accept claims while it creates the order and the checkout session.
 */
export const ORDER_REQUEST_STATUSES = [
  'waiting_review',
  'accepting',
  'accepted',
  'declined',
] as const

export type OrderRequestStatus = (typeof ORDER_REQUEST_STATUSES)[number]

export type OrderRequest = Record<string, unknown> & {
  id: string
  restaurant_id: string
  status: OrderRequestStatus
}

export async function getWaitingOrderRequests(
  restaurantId: string,
  scopeOverride?: OrderRestaurantScope | null,
): Promise<OrderRequest[]> {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const { data, error } = await supabase
    .from('order_requests')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('status', 'waiting_review')
    .order('placed_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as OrderRequest[]
}

/** Apply a Realtime event to the local waiting-review list, dropping rows that moved on. */
export function applyOrderRequestRealtimeEvent(
  prev: OrderRequest[],
  payload: OrderRequestRealtimePayload,
): OrderRequest[] {
  const { eventType, new: newRow, old: oldRow } = payload
  const id = String((newRow?.id ?? oldRow?.id) || '').trim()
  if (!id) return prev

  if (eventType === 'DELETE') {
    return prev.filter((request) => request.id !== id)
  }

  const row = newRow as OrderRequest | null
  if (!row) return prev

  if (row.status !== 'waiting_review') {
    return prev.filter((request) => request.id !== id)
  }

  const existingIndex = prev.findIndex((request) => request.id === id)
  if (existingIndex === -1) {
    return [...prev, row]
  }
  return prev.map((request) => (request.id === id ? { ...request, ...row } : request))
}

export type OrderRequestRealtimePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

/** Mirrors subscribeRestaurantOrdersRealtime (lib/supabase/orders.ts) for order_requests. */
export function subscribeOrderRequestsRealtime(
  restaurantId: string,
  callbacks: {
    onInitial: (requests: OrderRequest[]) => void
    onChange: (payload: OrderRequestRealtimePayload) => void
  },
  scopeOverride?: OrderRestaurantScope | null,
) {
  let channel: ReturnType<typeof supabase.channel> | null = null
  let cancelled = false

  const cleanup = () => {
    cancelled = true
    if (channel) {
      supabase.removeChannel(channel)
      channel = null
    }
  }

  const setup = async () => {
    const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
    if (cancelled) return

    try {
      const requests = await getWaitingOrderRequests(restaurantId, scope)
      if (!cancelled) callbacks.onInitial(requests)
    } catch (error) {
      console.error(error)
      if (!cancelled) callbacks.onInitial([])
    }

    if (cancelled) return

    const channelName = `order-requests-channel-${scope.restaurantId}`
    const nextChannel = supabase.channel(channelName)

    nextChannel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'order_requests',
        filter: `restaurant_id=eq.${scope.restaurantId}`,
      },
      (payload: { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
        if (cancelled) return
        const eventType = payload.eventType
        if (eventType !== 'INSERT' && eventType !== 'UPDATE' && eventType !== 'DELETE') return
        callbacks.onChange({
          eventType,
          new: (payload.new as Record<string, unknown> | undefined) ?? null,
          old: (payload.old as Record<string, unknown> | undefined) ?? null,
        })
      },
    )

    nextChannel.subscribe()

    if (cancelled) {
      supabase.removeChannel(nextChannel)
      return
    }

    channel = nextChannel
  }

  void setup().catch(console.error)

  return cleanup
}
