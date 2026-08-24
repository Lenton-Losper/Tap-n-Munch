import { NextResponse } from 'next/server'
import { formatPaycloudRequestSignature, loadPrivateKey, signUtf8WithForgePkcs1RsaSha256 } from '@/payments/signature'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import { ensureTerminalMerchantOrderNo } from '@/lib/payments/terminal-merchant-order'
import { markPaymentAttemptStarted } from '@/lib/payments/mark-payment-attempt-started'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { recordPaymentStatusChange } from '@/lib/orders/record-payment-status-change'

const ECR_ORDER_URL = 'https://open.finatic.africa/api/entry/ecrorder'

function buildCanonicalString(payload: Record<string, unknown>) {
  const keys = Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return keys.map((k) => `${k}=${String(payload[k])}`).join('&')
}

export async function POST(req: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.PAYMENTS_PROCESS, req)
    if (isAuthError(auth)) return auth

    const body = await req.json()
    console.log('[PUSH-TO-TERMINAL] Request body:', JSON.stringify(body))
    const { orderId, tableNumber, orderNumber } = body || {}
    const normalizedOrderId = String(orderId || '').trim()
    if (!normalizedOrderId) {
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Missing orderId')
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const { supabase, restaurantId: callerRestaurantId } = auth

    const { data: order, error: orderLookupError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', normalizedOrderId)
      .single()

    if (orderLookupError) {
      console.error('[PUSH-TO-TERMINAL] Order lookup failed', {
        orderId: normalizedOrderId,
        code: orderLookupError.code,
        message: orderLookupError.message,
        details: orderLookupError.details,
      })
      const invalidUuid = String(orderLookupError.message || '')
        .toLowerCase()
        .includes('invalid input syntax for type uuid')
      if (invalidUuid) {
        console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Invalid orderId format')
        return NextResponse.json({ error: 'Invalid orderId format' }, { status: 400 })
      }
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    if (!order) {
      console.error('[PUSH-TO-TERMINAL] Order not found', { orderId: normalizedOrderId })
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const orderRestaurantId = String(order.restaurant_id || '').trim()
    if (!orderRestaurantId || orderRestaurantId !== callerRestaurantId) {
      return NextResponse.json(
        { error: 'Order does not belong to this restaurant' },
        { status: 403 },
      )
    }

    if (String(order.payment_status || '').toLowerCase() === 'paid') {
      console.log('[PUSH-TO-TERMINAL] Order already paid, blocking duplicate:', normalizedOrderId)
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Order already paid')
      return NextResponse.json(
        {
          error: 'This order has already been paid',
          code: 'ALREADY_PAID',
        },
        { status: 400 }
      )
    }

    const resolvedAmount = Number(order.total)
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Invalid amount')
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
    }

    // Atomic claim: two concurrent pushes for the same order must not both reach Finatic.
    // Only the request whose conditional UPDATE actually matches a row (payment_status
    // still equal to what we just read) proceeds; the loser gets a clean 409 before ever
    // generating a merchantOrderNo or calling Finatic.
    const previousPaymentStatus = String(order.payment_status || '')
    const { data: claimedOrder, error: claimError } = await supabase
      .from('orders')
      // terminal_pushed_at starts the in-flight window that cash settlement respects.
      .update({ payment_status: 'terminal_pending', terminal_pushed_at: new Date().toISOString() })
      .eq('id', normalizedOrderId)
      .eq('payment_status', previousPaymentStatus)
      .select('*')
      .maybeSingle()

    if (claimError) {
      console.error('[PUSH-TO-TERMINAL] Claim update failed:', claimError)
      return NextResponse.json({ error: claimError.message }, { status: 500 })
    }
    if (!claimedOrder) {
      console.log('[PUSH-TO-TERMINAL] Returning 409 because:', 'Order already claimed by a concurrent push')
      return NextResponse.json(
        { error: 'This order is already being pushed to a terminal', code: 'ALREADY_CLAIMED' },
        { status: 409 },
      )
    }

    // #329: the claim itself is a payment_status transition, so it gets a row. No money has moved,
    // but this is the hop an investigation starts from when an order ends up somewhere unexplained.
    await recordPaymentStatusChange(supabase, {
      orderId: normalizedOrderId,
      restaurantId: String(claimedOrder.restaurant_id ?? ''),
      from: previousPaymentStatus || null,
      to: 'terminal_pending',
      source: 'payments/push-to-terminal',
      note:
        'Claimed for a card terminal push. No charge exists yet -- this only reserves the order so ' +
        'two concurrent pushes cannot both reach the gateway.',
      metadata: { orderTotal: claimedOrder.total ?? null },
    })

    // Release the claim back to previousPaymentStatus on any failure path below, so a
    // failed push doesn't permanently strand the order in 'terminal_pending' with no
    // successful Finatic session and no clean way to retry.
    const releaseClaim = async () => {
      const { error: releaseError } = await supabase
        .from('orders')
        .update({ payment_status: previousPaymentStatus, terminal_pushed_at: null })
        .eq('id', normalizedOrderId)
        .eq('payment_status', 'terminal_pending')
      if (releaseError) {
        console.error('[PUSH-TO-TERMINAL] Failed to release claim:', releaseError)
        return
      }
      // #329: releasing is a transition too. Without this row the order appears to have gone to
      // terminal_pending and back on its own.
      await recordPaymentStatusChange(supabase, {
        orderId: normalizedOrderId,
        restaurantId: String(claimedOrder.restaurant_id ?? ''),
        from: 'terminal_pending',
        to: previousPaymentStatus,
        source: 'payments/push-to-terminal:release',
        note:
          'The terminal push failed, so the claim was released and the order returned to the status ' +
          'it held before. No charge was made.',
      })
    }

    let merchantNo: string
    let storeNo: string
    let terminalSn: string | null
    try {
      const credentials = await getRestaurantFinaticCredentials(callerRestaurantId)
      merchantNo = credentials.merchantNo
      storeNo = credentials.storeNo
      terminalSn = credentials.terminalSn
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payment credentials'
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', message)
      await releaseClaim()
      return NextResponse.json({ error: message }, { status: 400 })
    }
    // Issue #151: a NULL `restaurants.finatic_terminal_sn` is NOT a misconfiguration, and
    // populating the column to "fix" this 400 is wrong. Mingle Brew & Pour and FNB ChowNow both
    // have real Finatic credentials and a NULL SN, and both take card payments successfully.
    //
    // Two distinct flows exist. This route is the REMOTE PUSH one: the dashboard tells a named
    // reader to charge, and the SN is how it addresses that specific device — so it genuinely
    // requires one. Those venues instead use the TERMINAL-INITIATED flow, where the terminal is
    // the reader: PaymentScreen -> processPaymentIntent -> Wiseasy SDK charges on the device,
    // then the app reports the result to settle. Nothing addresses a remote reader, so no SN is
    // needed and none is read.
    //
    // Setting an SN would not change the flow actually in use, and a WRONG one would break this
    // route if remote push were ever enabled for those venues.
    if (!terminalSn) {
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'No terminal configured for this restaurant')
      await releaseClaim()
      return NextResponse.json(
        {
          error: 'No terminal configured for this restaurant',
          code: 'NO_TERMINAL',
        },
        { status: 400 }
      )
    }
    const appId = process.env.PAYCLOUD_APP_ID
    console.log('[PUSH-TO-TERMINAL] Using terminal credentials:', {
      merchantNo,
      storeNo,
      terminalSn
    })

    if (!appId || !merchantNo || !storeNo) {
      await releaseClaim()
      return NextResponse.json(
        { error: 'Missing PayCloud configuration (PAYCLOUD_APP_ID / merchant / store)' },
        { status: 500 }
      )
    }

    // Delegate to the shared helper rather than reimplementing the rule here.
    //
    // terminal-merchant-order.ts is the single source of truth for this value and documents
    // why it must not rotate: "Does not rotate on every call (that would orphan webhooks for
    // the previous businessOrderNo)." It reuses a usable existing value, mints only when
    // there is nothing to reuse, compare-and-swaps against what is actually stored, retries
    // on unique collision, and re-reads to adopt the winner on a lost race.
    //
    // This route previously minted a fresh value on BOTH branches of a ternary, so every push
    // overwrote the column: a card already charged under the previous businessOrderNo could
    // no longer be correlated by Finatic's notify, and the payment was never recorded.
    let merchantOrderNo: string
    try {
      const ensured = await ensureTerminalMerchantOrderNo(supabase, {
        orderId: normalizedOrderId,
        restaurantId: callerRestaurantId,
      })
      merchantOrderNo = ensured.merchantOrderNo
    } catch (persistErr) {
      console.error('[PUSH-TO-TERMINAL] Failed to persist merchant order no:', persistErr)
      await releaseClaim()
      return NextResponse.json(
        {
          error:
            persistErr instanceof Error
              ? persistErr.message
              : 'Failed to persist merchant order no',
        },
        { status: 500 },
      )
    }

    const paramsForSigning: Record<string, unknown> = {
      app_id: appId,
      api_version: '2.0',
      format: 'JSON',
      charset: 'UTF-8',
      sign_type: 'RSA2',
      version: '1.0',
      timestamp: Date.now(),
      method: 'wisehub.cloud.pay.order',
      merchant_no: merchantNo,
      store_no: storeNo,
      terminal_sn: terminalSn,
      message_receiving_application: 'WISECASHIER',
      pay_scenario: 'SWIPE_CARD',
      price_currency: 'NAD',
      order_amount: resolvedAmount,
      trans_type: 1,
      merchant_order_no: merchantOrderNo,
      description: `FlashTap Table ${tableNumber} Order #${orderNumber}`,
      notify_url: 'https://www.flashtap.app/api/webhooks/paycloud',
      expires: 300,
      reject_trade_when_terminal_offline: 'false',
      required_terminal_authentication: 'false',
    }

    const canonicalString = buildCanonicalString(paramsForSigning)
    const privateKeyPem = loadPrivateKey()
    const signRaw = signUtf8WithForgePkcs1RsaSha256(canonicalString, privateKeyPem)
    const payload = {
      ...paramsForSigning,
      sign: formatPaycloudRequestSignature(signRaw),
    }
    console.log('[PUSH-TO-TERMINAL] Finatic payload:', {
      method: 'wisehub.cloud.pay.order',
      merchant_order_no: merchantOrderNo,
      order_amount: resolvedAmount,
      terminal_sn: terminalSn,
      merchant_no: merchantNo,
      store_no: storeNo
    })
    let data: Record<string, unknown>
    try {
      const response = await fetch(ECR_ORDER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(payload),
      })
      console.log('[PUSH-TO-TERMINAL] Finatic raw response status:', response.status)
      console.log('[PUSH-TO-TERMINAL] Finatic raw response body:', await response.clone().text())
      data = (await response.json().catch(() => ({}))) as Record<string, unknown>

      if (!response.ok || String(data?.code || '') !== '0') {
        const finaticReason = `Finatic error: HTTP ${response.status}, code=${String(data?.code ?? '')}, msg=${String(data?.msg || 'Failed to push to terminal')}`
        console.log('[PUSH-TO-TERMINAL] Returning 400 because:', finaticReason)
        await supabase
          .from('orders')
          .update({ payment_status: previousPaymentStatus, terminal_status: 'failed', terminal_pushed_at: null })
          .eq('id', normalizedOrderId)
          .eq('payment_status', 'terminal_pending')
        return NextResponse.json(
          {
            success: false,
            error: data?.msg || 'Failed to push to terminal',
            finatic: data,
          },
          { status: 400 }
        )
      }
    } catch (err) {
      console.error('[PUSH-TO-TERMINAL] Finatic call threw error:', err)
      console.error('[PUSH-TO-TERMINAL] Finatic call failed:', err)
      await supabase
        .from('orders')
        .update({ payment_status: previousPaymentStatus, terminal_status: 'failed', terminal_pushed_at: null })
        .eq('id', normalizedOrderId)
        .eq('payment_status', 'terminal_pending')
      return NextResponse.json(
        { error: 'Finatic call failed', details: String(err) },
        { status: 500 }
      )
    }

    await supabase
      .from('orders')
      .update({
        payment_status: 'terminal_pending',
        status: 'completed',
        terminal_status: 'pending',
        terminal_sn: terminalSn,
        // Restamped: the window should run from when Finatic accepted the push, not from the
        // earlier optimistic claim, so a slow gateway call does not eat into the timeout.
        terminal_pushed_at: new Date().toISOString(),
      })
      .eq('id', normalizedOrderId)

    await markPaymentAttemptStarted(supabase as any, {
      orderId: normalizedOrderId,
      restaurantId: callerRestaurantId,
      businessOrderNo: merchantOrderNo,
      source: 'staff_push',
      terminalSn,
      extraAuditMetadata: {
        flow: 'push_to_terminal',
        finaticResponseCode: String(data?.code ?? ''),
        finaticResponseMsg: String(data?.msg ?? ''),
      },
    })

    return NextResponse.json(
      {
        success: true,
        data: data?.data ?? null,
        finatic: data,
      },
      { status: 200 }
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to push to terminal'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
