import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { handleTerminalPaymentFailed } from '@/lib/payments/handle-terminal-payment-failed'
import { staffStatusRefusal } from '@/lib/orders/staff-status-refusal'
import { cancelOrderWithTrail } from '@/lib/orders/cancel-order-with-trail'

export const dynamic = 'force-dynamic'

const ALLOWED_STATUSES = new Set([
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'completed',
  'cancelled',
])

function isValidTransition(currentStatus: string, nextStatus: string): boolean {
  if (nextStatus === 'cancelled') {
    return currentStatus !== 'completed' && currentStatus !== 'cancelled'
  }

  const transitions: Record<string, string> = {
    pending: 'confirmed',
    confirmed: 'preparing',
    accepted: 'preparing',
    preparing: 'ready',
    ready: 'completed',
  }

  return transitions[currentStatus] === nextStatus
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json(
        { error: 'Missing permission: orders:update' },
        { status: 403 }
      )
    }

    const { orderId } = await params
    const body = await req.json().catch(() => ({}))
    const newStatus = String(body?.status || '').trim()

    console.log('[TERMINAL ORDER STATUS DEBUG]', {
      orderId,
      jwtTerminalId: terminal.terminalId,
      jwtRestaurantId: terminal.restaurantId,
      requestedStatus: body?.status,
    })

    if (!newStatus || !ALLOWED_STATUSES.has(newStatus)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    console.log('[TERMINAL ORDER LOOKUP]', {
      found: !!order,
      order,
      error,
    })

    const { data: orderNoFilter } = await supabase
      .from('orders')
      .select('id, restaurant_id, status')
      .eq('id', orderId)
      .single()

    console.log('[ORDER WITHOUT RESTAURANT FILTER]', orderNoFilter)

    if (error) {
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
    }

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const currentStatus = String(order.status || '')

    if (!isValidTransition(currentStatus, newStatus)) {
      /**
       * #275, terminal side. The device renders `error` verbatim, so this string is what a staff
       * member reads on the terminal -- and it was two database identifiers and an arrow.
       *
       * SAFE TO CHANGE WITHOUT AN APK: grepped C:\RN\FlashTapTerminal/src for "Invalid
       * transition" and "Invalid status" and there are no matches, so nothing on the device keys
       * on the prose. The `code` is emitted so that anything which wants to react in future has
       * something stable to react to.
       */
      const refusal = staffStatusRefusal(currentStatus, newStatus)
      return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 400 })
    }

    // Cancel with a Finatic attempt already initiated: same verify-before-cancel as
    // the payment status=failed callback (order #635). Pre-payment cancels (no
    // paycloud_merchant_order_no) skip Finatic and cancel immediately below.
    if (newStatus === 'cancelled') {
      const callerReason = String(
        body?.cancellation_reason ?? body?.cancellationReason ?? body?.reason ?? '',
      ).trim()
      const cancellationReason = callerReason || 'terminal_cancelled'
      const merchantOrderNo = String(order.paycloud_merchant_order_no || '').trim()

      if (merchantOrderNo) {
        let failedResult
        try {
          failedResult = await handleTerminalPaymentFailed(
            supabase,
            {
              orderId,
              restaurantId: terminal.restaurantId,
              orderTotal: Number(order.total),
              paycloudMerchantOrderNo: merchantOrderNo,
              terminalId: terminal.terminalId,
              paymentMethod: order.payment_method ? String(order.payment_method) : 'card',
              cancellationReason,
              /**
               * The other half of the bypass. This route already forwarded the reason but not
               * this flag, so handleTerminalPaymentFailed's two-part check could never pass here
               * either — the same defect as the payment route, one field further along.
               *
               * `=== true` deliberately: the JSON string "false" is truthy.
               */
              noGatewayAttempt: body?.noGatewayAttempt === true,
              auditAction: 'order.cancelled',
              correctionSource: 'terminal_status_cancel_false_failure_finatic_verified',
              correctionReason:
                'Terminal PATCH status=cancelled after a Finatic payment attempt, but Finatic order.query confirmed paid — corrected instead of cancelling (false-failure guard).',
            },
            { stagingFinaticStub: body?.__stagingFinaticStub },
          )
        } catch (cancelErr: unknown) {
          const message = cancelErr instanceof Error ? cancelErr.message : 'Cancel failed'
          console.error('[terminal/status] handleTerminalPaymentFailed error:', cancelErr)
          return NextResponse.json({ error: message }, { status: 500 })
        }

        if (failedResult.outcome === 'cancel_conflict') {
          return NextResponse.json(
            {
              error: 'Order could not be cancelled',
              code: 'PAYMENT_CANCEL_CONFLICT',
            },
            { status: 409 },
          )
        }

        if (failedResult.outcome === 'corrected_to_paid') {
          const { data: paidOrder } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .maybeSingle()
          return NextResponse.json({
            success: true,
            outcome: 'corrected_to_paid',
            order: paidOrder,
          })
        }

        if (failedResult.outcome === 'left_pending_finatic_uncertain') {
          return NextResponse.json({
            success: true,
            outcome: 'left_pending_finatic_uncertain',
            reason: failedResult.reason,
            order,
          })
        }

        const { data: cancelledOrder } = await supabase
          .from('orders')
          .select('*')
          .eq('id', orderId)
          .maybeSingle()
        return NextResponse.json({
          success: true,
          outcome: 'cancelled',
          order: cancelledOrder,
        })
      }

      /**
       * No merchant_order_no — pre-payment abandon; cancel immediately (safe).
       *
       * Goes through cancelOrderWithTrail so the audit row CANNOT be omitted. Until 2026-08-22 this
       * branch wrote all four order columns and no audit row, which is why Riviera #7 (cancelled
       * 2026-08-18) is the one untracked `terminal_cancelled` row on production. `guard: 'none'`
       * preserves this branch's existing behaviour exactly -- see the parameter's docblock.
       */
      let cancelResult
      try {
        cancelResult = await cancelOrderWithTrail(supabase, {
          orderId,
          restaurantId: terminal.restaurantId,
          cancellationReason,
          basis: 'terminal_pre_gateway',
          guard: 'none',
          metadata: { terminalId: terminal.terminalId ?? null, requestedStatus: newStatus },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[STATUS UPDATE ERROR FULL]', JSON.stringify({ message, orderId, newStatus }))
        return NextResponse.json({ error: message }, { status: 500 })
      }

      if (!cancelResult.cancelled) {
        console.error('[STATUS UPDATE ERROR FULL]', JSON.stringify({ message: 'Update returned no rows', orderId, newStatus }))
        return NextResponse.json({ error: 'Failed to update order — no rows returned' }, { status: 500 })
      }

      return NextResponse.json({ success: true, outcome: 'cancelled', order: cancelResult.order })
    }

    const updates: Record<string, unknown> = { status: newStatus }

    const { data, error: updateError } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .select()

    console.error('[STATUS UPDATE ERROR FULL]', JSON.stringify(updateError))
    console.log('[STATUS UPDATE DATA]', JSON.stringify(data))

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message, details: updateError },
        { status: 500 }
      )
    }

    const updatedOrder = data?.[0]
    if (!updatedOrder) {
      console.error('[STATUS UPDATE ERROR FULL]', JSON.stringify({ message: 'Update returned no rows', orderId, newStatus }))
      return NextResponse.json({ error: 'Failed to update order — no rows returned' }, { status: 500 })
    }

    return NextResponse.json({ success: true, order: updatedOrder })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
