import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function restaurantName(relation: unknown): string | null {
  if (Array.isArray(relation)) {
    const first = relation[0]
    return first && typeof first === 'object' && 'name' in first
      ? String((first as { name: unknown }).name)
      : null
  }
  if (relation && typeof relation === 'object' && 'name' in relation) {
    return String((relation as { name: unknown }).name)
  }
  return null
}

type TimelineItem = {
  id: string
  at: string
  label: string
  detail?: string | null
  status: 'ok' | 'fail' | 'info'
  payload?: unknown
}

/**
 * GET /api/platform/payments/events/[id]
 * id can be:
 *   - payment event uuid
 *   - event:<uuid>
 *   - order:<uuid>
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const rawId = (await params).id
    const supabase = createServerSupabaseClient()

    let mode: 'event' | 'order' = 'event'
    let id = rawId
    if (rawId.startsWith('event:')) {
      mode = 'event'
      id = rawId.slice('event:'.length)
    } else if (rawId.startsWith('order:')) {
      mode = 'order'
      id = rawId.slice('order:'.length)
    }

    if (mode === 'order') {
      const { data: order, error } = await supabase
        .from('orders')
        .select(
          // `payment_trans_no` was dropped from this list deliberately (#195).
          //
          // Its ONLY writer was lib/supabase/apply-tab-settlement.ts:36 and :45, and that module
          // has had no caller since 2026-06-02 — which is why 5d611bf deletes it. So the column
          // has had no effective writer for weeks, and every order placed since then carries a
          // blank. Removing the module does not create that blank; it removes the last code that
          // made the field look maintained.
          //
          // Nothing displayed it either: this route spread the whole row into the response, but
          // app/admin/payments/page.tsx never read the field. It was selected, serialised and
          // dropped.
          //
          // The three sibling markers all still have live writers on real payment paths and are
          // kept: paycloud_transaction_id (app/api/payments/reconcile/route.ts:172),
          // payment_voucher_no (lib/payments/mark-order-paid-confirmed.ts:68) and
          // payment_reference (app/api/payments/receipt/route.ts:143).
          'id, restaurant_id, order_number, status, payment_status, payment_method, total, paycloud_merchant_order_no, payment_reference, payment_voucher_no, paycloud_transaction_id, placed_at, paid_at, restaurants(name)',
        )
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 })

      const businessNo = order.paycloud_merchant_order_no || null
      const [{ data: relatedEvents }, { data: audits }] = await Promise.all([
        businessNo
          ? supabase
              .from('payment_events')
              .select(
                'id, event_type, business_order_no, transaction_id, amount, currency, gateway_result_code, gateway_result_message, reason_code, reason_note, raw_gateway_response, created_at, terminal_id, app_version',
              )
              .eq('restaurant_id', order.restaurant_id)
              .eq('business_order_no', businessNo)
              .order('created_at', { ascending: true })
          : supabase
              .from('payment_events')
              .select(
                'id, event_type, business_order_no, transaction_id, amount, currency, gateway_result_code, gateway_result_message, reason_code, reason_note, raw_gateway_response, created_at, terminal_id, app_version',
              )
              .contains('order_ids', [order.id])
              .order('created_at', { ascending: true }),
        supabase
          .from('audit_logs')
          .select('id, action, entity_type, entity_id, metadata, created_at')
          .eq('restaurant_id', order.restaurant_id)
          .eq('entity_id', order.id)
          .order('created_at', { ascending: true })
          .limit(40),
      ])

      const timeline: TimelineItem[] = []
      if (order.placed_at) {
        timeline.push({
          id: `placed-${order.id}`,
          at: order.placed_at,
          label: 'Order placed',
          detail: `Payment status ${order.payment_status}`,
          status: 'info',
        })
      }
      for (const ev of relatedEvents ?? []) {
        const failed = String(ev.event_type).includes('fail')
        timeline.push({
          id: `ev-${ev.id}`,
          at: ev.created_at,
          label: humanEvent(ev.event_type),
          detail: [ev.gateway_result_code, ev.gateway_result_message, ev.reason_note]
            .filter(Boolean)
            .join(' · '),
          status: failed ? 'fail' : 'ok',
          payload: ev.raw_gateway_response ?? {
            event_type: ev.event_type,
            business_order_no: ev.business_order_no,
            transaction_id: ev.transaction_id,
            gateway_result_code: ev.gateway_result_code,
            gateway_result_message: ev.gateway_result_message,
            amount: ev.amount,
            currency: ev.currency,
          },
        })
      }
      if (order.paid_at) {
        timeline.push({
          id: `paid-${order.id}`,
          at: order.paid_at,
          label: 'Order marked paid',
          detail: order.payment_voucher_no ? `Voucher ${order.payment_voucher_no}` : null,
          status: 'ok',
        })
      }
      for (const audit of audits ?? []) {
        timeline.push({
          id: `audit-${audit.id}`,
          at: audit.created_at,
          label: String(audit.action),
          detail: String(audit.entity_type || ''),
          status: String(audit.action).includes('fail') ? 'fail' : 'info',
          payload: audit.metadata,
        })
      }
      timeline.sort((a, b) => a.at.localeCompare(b.at))

      return NextResponse.json({
        kind: 'order',
        order: {
          ...order,
          restaurant_name: restaurantName(order.restaurants),
        },
        relatedEvents: relatedEvents ?? [],
        timeline,
      })
    }

    // payment event detail
    const { data: event, error } = await supabase
      .from('payment_events')
      .select(
        'id, restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no, transaction_id, terminal_id, app_version, amount, currency, reason_code, reason_note, gateway_result_code, gateway_result_message, raw_gateway_response, idempotency_key, created_at, restaurants(name)',
      )
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!event) return NextResponse.json({ error: 'Payment event not found.' }, { status: 404 })

    const orderIds = Array.isArray(event.order_ids) ? event.order_ids.map(String) : []
    const [{ data: relatedEvents }, { data: orders }, { data: audits }] = await Promise.all([
      supabase
        .from('payment_events')
        .select(
          'id, event_type, business_order_no, transaction_id, amount, currency, gateway_result_code, gateway_result_message, reason_code, reason_note, raw_gateway_response, created_at, terminal_id, app_version',
        )
        .eq('restaurant_id', event.restaurant_id)
        .eq('business_order_no', event.business_order_no)
        .order('created_at', { ascending: true }),
      orderIds.length
        ? supabase
            .from('orders')
            .select(
              'id, order_number, status, payment_status, total, paycloud_merchant_order_no, payment_voucher_no, placed_at, paid_at',
            )
            .in('id', orderIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      orderIds.length
        ? supabase
            .from('audit_logs')
            .select('id, action, entity_type, entity_id, metadata, created_at')
            .eq('restaurant_id', event.restaurant_id)
            .in('entity_id', orderIds)
            .order('created_at', { ascending: true })
            .limit(40)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ])

    const timeline: TimelineItem[] = []
    for (const order of orders ?? []) {
      if (order.placed_at) {
        timeline.push({
          id: `placed-${order.id}`,
          at: String(order.placed_at),
          label: `Order #${order.order_number || order.id} placed`,
          detail: `Payment ${order.payment_status}`,
          status: 'info',
        })
      }
    }
    for (const ev of relatedEvents ?? []) {
      const failed = String(ev.event_type).includes('fail')
      timeline.push({
        id: `ev-${ev.id}`,
        at: ev.created_at,
        label: humanEvent(ev.event_type),
        detail: [ev.gateway_result_code, ev.gateway_result_message, ev.reason_note]
          .filter(Boolean)
          .join(' · '),
        status: failed ? 'fail' : 'ok',
        payload: ev.raw_gateway_response ?? {
          event_type: ev.event_type,
          business_order_no: ev.business_order_no,
          transaction_id: ev.transaction_id,
          gateway_result_code: ev.gateway_result_code,
          gateway_result_message: ev.gateway_result_message,
          amount: ev.amount,
          currency: ev.currency,
          terminal_id: ev.terminal_id,
          app_version: ev.app_version,
        },
      })
    }
    for (const order of orders ?? []) {
      if (order.paid_at) {
        timeline.push({
          id: `paid-${order.id}`,
          at: String(order.paid_at),
          label: `Order #${order.order_number || order.id} marked paid`,
          detail: order.payment_voucher_no ? `Voucher ${order.payment_voucher_no}` : null,
          status: 'ok',
        })
      }
    }
    for (const audit of audits ?? []) {
      timeline.push({
        id: `audit-${audit.id}`,
        at: String(audit.created_at),
        label: String(audit.action),
        detail: String(audit.entity_type || ''),
        status: String(audit.action).includes('fail') ? 'fail' : 'info',
        payload: audit.metadata,
      })
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at))

    return NextResponse.json({
      kind: 'payment_event',
      event: {
        ...event,
        restaurant_name: restaurantName(event.restaurants),
      },
      orders: orders ?? [],
      relatedEvents: relatedEvents ?? [],
      timeline,
    })
  } catch (error) {
    console.error('[platform/payments/events/[id]] GET', error)
    return NextResponse.json({ error: 'Failed to load payment detail.' }, { status: 500 })
  }
}

function humanEvent(type: string | null | undefined) {
  const t = String(type || 'event')
  if (t === 'sale') return 'Sale / purchase recorded'
  if (t === 'refund_attempted') return 'Refund attempted'
  if (t === 'refund_succeeded') return 'Refund succeeded'
  if (t === 'refund_failed') return 'Refund failed'
  return t.replace(/_/g, ' ')
}
