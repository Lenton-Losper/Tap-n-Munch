import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

type SaleBody = {
  order_ids?: unknown
  business_order_no?: unknown
  transaction_id?: unknown
  amount?: unknown
  currency?: unknown
  app_version?: unknown
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' || Boolean(error?.message?.includes('duplicate key'))
}

function orderIdSetsEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const id of setA) {
    if (!setB.has(id)) return false
  }
  return true
}

function amountsEqual(a: unknown, b: number): boolean {
  return Number(a) === b
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as SaleBody

    if (!Array.isArray(body.order_ids) || body.order_ids.length === 0) {
      return NextResponse.json(
        { error: 'order_ids must be a non-empty array' },
        { status: 400 },
      )
    }

    const orderIds = body.order_ids.map((id) => String(id).trim())
    const invalidUuidOrderIds = orderIds.filter((id) => !isUuid(id))
    if (invalidUuidOrderIds.length > 0) {
      return NextResponse.json(
        { error: 'Invalid order_ids', invalid_order_ids: invalidUuidOrderIds },
        { status: 400 },
      )
    }

    const businessOrderNo = String(body.business_order_no ?? '').trim()
    if (!businessOrderNo) {
      return NextResponse.json(
        { error: 'business_order_no must be a non-empty string' },
        { status: 400 },
      )
    }

    const transactionId = String(body.transaction_id ?? '').trim()
    if (!transactionId) {
      return NextResponse.json(
        { error: 'transaction_id must be a non-empty string' },
        { status: 400 },
      )
    }

    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a finite number greater than 0' },
        { status: 400 },
      )
    }

    const currency =
      body.currency != null && String(body.currency).trim()
        ? String(body.currency).trim()
        : 'NAD'
    const appVersion =
      body.app_version != null && String(body.app_version).trim()
        ? String(body.app_version).trim()
        : null

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('id')
      .in('id', orderIds)
      .eq('restaurant_id', terminal.restaurantId)

    if (ordersError) {
      return NextResponse.json({ error: 'Failed to validate order_ids' }, { status: 500 })
    }

    const foundOrderIds = new Set((orders ?? []).map((order) => String(order.id)))
    const invalidOrderIds = orderIds.filter((id) => !foundOrderIds.has(id))
    if (invalidOrderIds.length > 0) {
      return NextResponse.json(
        { error: 'Invalid order_ids', invalid_order_ids: invalidOrderIds },
        { status: 400 },
      )
    }

    const insertPayload = {
      restaurant_id: terminal.restaurantId,
      order_ids: orderIds,
      event_type: 'sale' as const,
      business_order_no: businessOrderNo,
      origin_business_order_no: businessOrderNo,
      transaction_id: transactionId,
      terminal_id: terminal.terminalId,
      app_version: appVersion,
      amount,
      currency,
      initiated_by: null,
      idempotency_key: businessOrderNo,
      reason_code: 'sale',
    }

    const { data: created, error: insertError } = await supabase
      .from('payment_events')
      .insert(insertPayload)
      .select('*')
      .single()

    if (!insertError && created) {
      return NextResponse.json(created)
    }

    if (isUniqueViolation(insertError)) {
      const { data: existing, error: existingError } = await supabase
        .from('payment_events')
        .select('*')
        .eq('restaurant_id', terminal.restaurantId)
        .eq('idempotency_key', businessOrderNo)
        .single()

      if (existingError || !existing) {
        return NextResponse.json(
          { error: 'Failed to load existing payment event' },
          { status: 500 },
        )
      }

      const existingOrderIds = Array.isArray(existing.order_ids)
        ? existing.order_ids.map((id: unknown) => String(id))
        : []
      const orderIdsMatch = orderIdSetsEqual(existingOrderIds, orderIds)
      const amountMatch = amountsEqual(existing.amount, amount)

      if (!orderIdsMatch || !amountMatch) {
        console.error(
          '[terminal/payment-events/sale] business_order_no conflict: existing row differs from retry payload',
          {
            business_order_no: businessOrderNo,
            restaurant_id: terminal.restaurantId,
            existing: { order_ids: existingOrderIds, amount: existing.amount },
            incoming: { order_ids: orderIds, amount },
          },
        )
        return NextResponse.json(
          {
            error: 'business_order_no already recorded with different order_ids/amount',
          },
          { status: 409 },
        )
      }

      return NextResponse.json(existing)
    }

    console.error('[terminal/payment-events/sale] insert failed:', insertError)
    return NextResponse.json({ error: 'Failed to record payment event' }, { status: 500 })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/payment-events/sale]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
