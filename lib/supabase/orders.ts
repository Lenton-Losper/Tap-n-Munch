import { createServerSupabaseClient } from './server'
import { supabase } from './client'
import {
  resolveOrderRestaurantScope,
  resolveRestaurantUuid,
  type OrderRestaurantScope,
} from './restaurants'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { HELD_FOR_REVIEW_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'
import { STRANDED_PENDING_THRESHOLD_MS } from '@/lib/orders/held-for-review'

export type Order = Record<string, unknown> & {
  id: string
  restaurant_id: string
}

/*
 * CREATE ORDER — DELETED, #127.
 *
 * `createSupabaseOrder` was a third way to insert an `orders` row, and it took `order_number?:
 * number` as an OPTIONAL parameter it never filled in. A caller that omitted it created an order
 * with a NULL number — the producer side of the "Order #0" family that
 * scripts/check-order-number-guard.ts exists to catch on the render side.
 *
 * No caller, anywhere: app/, lib/, components/, hooks/, scripts/ and __tests__/ all checked
 * before removal.
 *
 * Orders are created by lib/orders/create-order.ts, which allocates through
 * lib/orders/order-number.ts. That is the only path, and scripts/check-order-number-allocation.ts
 * now fails the build if a second one appears.
 */

// GET ORDER BY ID
export async function getSupabaseOrder(orderId: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single()
  if (error) throw error
  return data
}

// GET ORDERS BY RESTAURANT AND STATUS
export async function getSupabaseOrdersByStatus(
  restaurantId: string,
  status: string,
  scopeOverride?: OrderRestaurantScope | null
) {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const data = await fetchAllRows(
    supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', scope.restaurantId)
      .eq('status', status)
      .eq('is_closed', false)
      .order(status === 'completed' ? 'completed_at' : 'placed_at', {
        ascending: status !== 'completed',
        nullsFirst: false,
      }),
    { label: 'getOrdersByStatus' },
  )
  return data ?? []
}

// GET ORDERS BY TABLE
export async function getSupabaseOrdersByTable(restaurantId: string, tableNumber: number) {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)
    .order('placed_at', { ascending: true })
  if (error) throw error
  return data
}

/*
 * FOUR WRITERS REMOVED HERE, #329, 2026-08-24: updateSupabaseOrderStatus,
 * updateSupabaseOrderPayment, updateSupabaseOrderByMerchantNo, closeSupabaseTableOrders.
 *
 * All four had ZERO callers anywhere in the repository, tests included. They are recorded here
 * rather than only in git because the reason for the deletion is a property of their SHAPE, and
 * the next person tempted to reintroduce one of them will be looking at this file.
 *
 * updateSupabaseOrderPayment took a free-text payment status, set `paid_at` when it happened to
 * be 'paid', wrote NO audit row, and was scoped by `.eq('id', orderId)` with NO restaurant_id.
 * That is a cross-tenant, untrailed 'mark any order paid' -- one import away from being live, and
 * it would have passed review precisely because it looked like the house helper.
 *
 * updateSupabaseOrderByMerchantNo took an arbitrary `updates` object keyed on a gateway reference,
 * which is the same hole with an extra step.
 *
 * Money statuses are written through paths that leave a trail: lib/orders/cancel-order-with-trail
 * for cancels, lib/payments/mark-order-paid-confirmed for paid. Use those.
 */
/** Hosted checkout orders awaiting payment (not a workflow status). */
export async function getPendingHostedOrders(
  restaurantId: string,
  scopeOverride?: OrderRestaurantScope | null
) {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const data = await fetchAllRows(
    supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', scope.restaurantId)
      .eq('payment_status', 'pending')
      .eq('payment_channel', 'hosted')
      .eq('is_closed', false)
      .order('placed_at', { ascending: false }),
    { label: 'getPendingHostedOrders' },
  )
  return data ?? []
}

/** All open orders for a restaurant (single query for dashboard realtime cache). */
export async function getAllOpenRestaurantOrders(
  restaurantId: string,
  scopeOverride?: OrderRestaurantScope | null
) {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const data = await fetchAllRows(
    supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', scope.restaurantId)
      .eq('is_closed', false)
      .order('placed_at', { ascending: false }),
    { label: 'getOpenOrders' },
  )
  return data ?? []
}

/**
 * #353 — the rows behind the "Held for review" surface: not paid, not cancelled, needs a person.
 *
 * THE ABSENT FILTER IS THE POINT. Every other read in this file carries `.eq('is_closed', false)`.
 * This one must not, and the reason is measured rather than theoretical: on production 2026-08-27
 * ALL twenty stale pending orders carry `is_closed = true`, and exactly ONE order in the whole
 * database has `is_closed = false`. Adding that filter here would return zero rows while N$484 sat
 * unresolved — a false all-clear, which is a worse outcome than having no surface at all. The
 * close route already documents the mechanism: it detaches unpaid orders from the table with
 * their payment_status preserved and sets is_closed=true, so "money still owed stays RECORDED and
 * becomes INVISIBLE at the same moment".
 *
 * TWO QUERIES, NOT ONE `.or()`. The predicate is a disjunction — a held status at ANY age, or
 * plain `pending` past the stranded threshold — and PostgREST expresses that with `.or()`, whose
 * argument is a string parsed server-side. `.eq()`/`.in()`/`.lt()` are parser-free. Nothing here
 * is user-supplied today, so this is not a live injection; it is refusing to open the seam at all
 * in a file where the next caller might pass something that is. Same reformulate-don't-sanitise
 * ruling as by-payment-ref.
 *
 * NO AGE FILTER ON THE HELD LEG. A gateway has already answered about those orders; they need a
 * person immediately, not in two hours.
 *
 * The status='cancelled'-but-payment_status='pending' rows are NOT excluded here. Filtering them
 * in SQL would need a byte-exact comparison against a free-text column; `heldForReviewCause`
 * drops them after normalising, which is the house rule for status columns.
 */
export async function getHeldForReviewOrders(
  restaurantId: string,
  options?: {
    scopeOverride?: OrderRestaurantScope | null
    /** Cut-off for the stranded-`pending` leg. Defaults to STRANDED_PENDING_THRESHOLD_MS ago. */
    strandedBefore?: Date
    thresholdMs?: number
  },
) {
  const scope =
    options?.scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const thresholdMs = options?.thresholdMs ?? STRANDED_PENDING_THRESHOLD_MS
  const cutoff = (options?.strandedBefore ?? new Date(Date.now() - thresholdMs)).toISOString()

  const heldRows = await fetchAllRows(
    supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', scope.restaurantId)
      .in('payment_status', [...HELD_FOR_REVIEW_PAYMENT_STATUSES])
      .order('placed_at', { ascending: true }),
    { label: 'getHeldForReviewOrders:held' },
  )

  const strandedRows = await fetchAllRows(
    supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', scope.restaurantId)
      .eq('payment_status', 'pending')
      .lt('placed_at', cutoff)
      .order('placed_at', { ascending: true }),
    { label: 'getHeldForReviewOrders:stranded' },
  )

  // Dedupe by id. The two legs cannot overlap today, but a future status that is both `pending`
  // and a member of the held set would be rendered twice, and a duplicated row on a money screen
  // reads as a second unpaid order.
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of [...(heldRows ?? []), ...(strandedRows ?? [])]) {
    const id = String((row as { id?: unknown }).id ?? '')
    if (id) byId.set(id, row as Record<string, unknown>)
  }
  return [...byId.values()]
}

export type OrderRealtimePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

/**
 * Single Realtime channel for all order INSERT/UPDATE/DELETE events for a restaurant.
 */
export function subscribeRestaurantOrdersRealtime(
  restaurantId: string,
  callbacks: {
    onInitial: (orders: any[]) => void
    onChange: (payload: OrderRealtimePayload) => void
    onStatus?: (status: string) => void
  },
  scopeOverride?: OrderRestaurantScope | null
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
    const scope =
      scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))

    if (cancelled) return

    try {
      const orders = await getAllOpenRestaurantOrders(restaurantId, scope)
      if (!cancelled) callbacks.onInitial(orders)
    } catch (error) {
      console.error(error)
      if (!cancelled) callbacks.onInitial([])
    }

    if (cancelled) return

    const channelName = `orders-channel-${scope.restaurantId}`
    const nextChannel = supabase.channel(channelName)

    const onOrderChange = (payload: {
      eventType?: string
      new?: Record<string, unknown>
      old?: Record<string, unknown>
    }) => {
      if (cancelled) return
      const eventType = payload.eventType
      if (eventType !== 'INSERT' && eventType !== 'UPDATE' && eventType !== 'DELETE') return

      callbacks.onChange({
        eventType,
        new: (payload.new as Record<string, unknown> | undefined) ?? null,
        old: (payload.old as Record<string, unknown> | undefined) ?? null,
      })
    }

    nextChannel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `restaurant_id=eq.${scope.restaurantId}`,
      },
      onOrderChange
    )

    nextChannel.subscribe((status: string) => {
      callbacks.onStatus?.(status)
    })

    if (cancelled) {
      supabase.removeChannel(nextChannel)
      return
    }

    channel = nextChannel
  }

  void setup().catch(console.error)

  return cleanup
}

// SUBSCRIBE TO ORDERS BY STATUS (realtime)
export function subscribeSupabaseOrders(
  restaurantId: string,
  status: string,
  callback: (orders: any[]) => void,
  scopeOverride?: OrderRestaurantScope | null
) {
  return subscribeRestaurantOrders(
    restaurantId,
    (scope) => getSupabaseOrdersByStatus(restaurantId, status, scope),
    callback,
    scopeOverride,
    status
  )
}

/** Realtime subscription for hosted pending-payment orders (payment filter, not workflow status). */
export function subscribePendingHostedOrders(
  restaurantId: string,
  callback: (orders: any[]) => void,
  scopeOverride?: OrderRestaurantScope | null
) {
  return subscribeRestaurantOrders(
    restaurantId,
    (scope) => getPendingHostedOrders(restaurantId, scope),
    callback,
    scopeOverride,
    'pending-hosted'
  )
}

function subscribeRestaurantOrders(
  restaurantId: string,
  fetchOrders: (scope: OrderRestaurantScope) => Promise<any[]>,
  callback: (orders: any[]) => void,
  scopeOverride: OrderRestaurantScope | null | undefined,
  channelSuffix: string
) {
  let removeChannel: (() => void) | undefined
  let cancelled = false

  const setup = async () => {
    const scope =
      scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))

    if (cancelled) return

    const refetchOrders = () => {
      if (cancelled) return
      fetchOrders(scope)
        .then((orders) => {
          if (!cancelled) callback(Array.isArray(orders) ? orders : [])
        })
        .catch(console.error)
    }

    refetchOrders()
    if (cancelled) return

    const channelName = `orders-${scope.restaurantId}-${channelSuffix}`
    const channel = supabase.channel(channelName)

    const onOrderChange = (_payload: { eventType?: string; new?: Record<string, unknown> }) => {
      refetchOrders()
    }

    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `restaurant_id=eq.${scope.restaurantId}`,
      },
      onOrderChange
    )

    channel.subscribe()

    removeChannel = () => supabase.removeChannel(channel)
  }

  void setup().catch(console.error)

  return () => {
    cancelled = true
    removeChannel?.()
  }
}

/*
 * GET ORDER NUMBER — DELETED, #127.
 *
 * `getNextSupabaseOrderNumber` and its alias `getNextOrderNumber` were a THIRD copy of
 * `SELECT count(*) + 1`, and the most dangerous one: it counted by `restaurant_id` while both
 * live allocators counted by `firebase_restaurant_id`, so a caller picking this one would have
 * been numbering against a different scope than the unique index constrains.
 *
 * Neither had a caller. Verified across app/, lib/, components/, hooks/, scripts/ AND __tests__/
 * before removal — "no consumer" has meant "no consumer outside the test suite" here before, and
 * a test importer is what actually breaks.
 *
 * Allocation now lives in lib/orders/order-number.ts, which is the only place that may issue one.
 */

export async function createOrder(orderData: any): Promise<string> {
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderData),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Order failed')
  return String(result.orderId)
}

export async function getOrders(restaurantId: string, status?: string): Promise<Order[]> {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  let query = supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .order('placed_at', { ascending: false })
  if (status) query = query.eq('status', status)
  // #323: FNB ChowNow already holds 849 orders here -- 85% of the 1000-row cap, and this read has
  // no date filter at all, so it is the first of the four that would have started truncating.
  const data = await fetchAllRows(query, { label: 'getOrders' })
  return (data || []) as Order[]
}

export async function getOrder(restaurantId: string, orderId: string): Promise<Order | null> {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw error
  return (data as Order) || null
}

export async function updateOrderStatus(restaurantId: string, orderId: string, status: string) {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const patch: Record<string, any> = { status, updated_at: new Date().toISOString() }
  if (status === 'accepted') patch.accepted_at = new Date().toISOString()
  if (status === 'ready') patch.ready_at = new Date().toISOString()
  if (status === 'completed') patch.completed_at = new Date().toISOString()
  const { error } = await createServerSupabaseClient()
    .from('orders')
    .update(patch)
    .eq('restaurant_id', scope.restaurantId)
    .eq('id', orderId)
  if (error) throw error
}

/*
 * updateOrderPayment REMOVED with them (#329, 2026-08-24). Also zero callers.
 *
 * It was a thin wrapper over updateSupabaseOrderPayment that took a `restaurantId` and then never
 * used it for scoping -- it passed only the order id through. So it read as the scoped, safe
 * version of its sibling and was neither. That is worse than the unscoped one it wrapped, because
 * the signature is the reassurance.
 */
export function subscribeToOrders(
  restaurantId: string,
  status: string,
  callback: (orders: any[]) => void
) {
  return subscribeSupabaseOrders(restaurantId, status, callback)
}

export { resolveOrderRestaurantScope, resolveRestaurantUuid } from './restaurants'
