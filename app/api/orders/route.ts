import { NextResponse } from 'next/server'
import { prepareForFirestore } from '@/lib/firebase/firestore-guards'
import { orderPath, ordersPath, tabPath } from '@/lib/firebase/paths'
import { createPaymentRequest, maskSecrets } from '@/payments/paycloud'
import { FieldValue, adminDb } from '@/lib/firebase/admin-firestore'

const ADMIN_NOT_CONFIGURED =
  'Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel) to environment variables and redeploy.'

/** Hosted PayCloud checkout (pay.paycloud.checkout) — online card payments */
const HOSTED_CHECKOUT_MERCHANT_NO = '342600032359'
const HOSTED_CHECKOUT_STORE_NO = '4426010221'

async function getNextOrderNumberAdmin(restaurantId: string, fs: NonNullable<ReturnType<typeof adminDb>>): Promise<number> {
  const snap = await fs.collection(ordersPath(restaurantId)).orderBy('order_number', 'desc').limit(1).get()
  if (snap.empty) return 1
  const n = snap.docs[0]!.data().order_number
  return (typeof n === 'number' ? n : 0) + 1
}

function logPayCloudInitFailure(ctx: { docRefId: string; merchantOrderNo: string }, err: unknown) {
  const e = err as {
    message?: string
    name?: string
    phase?: string
    httpStatus?: number
    responseBody?: unknown
    rawText?: string
  }
  console.error('[PayCloud] Payment initialization failed — detailed log', {
    orderDocId: ctx.docRefId,
    merchantOrderNo: ctx.merchantOrderNo,
    errorMessage: e?.message,
    errorName: e?.name,
    phase: e?.phase,
    httpStatus: e?.httpStatus ?? null,
    responseBodyMasked: e?.responseBody != null ? maskSecrets(e.responseBody) : null,
    responseBodyFull: e?.responseBody ?? null,
    rawTextLength: e?.rawText != null ? e.rawText.length : null,
    rawTextFull: e?.rawText ?? null,
  })
}

function buildMerchantOrderNo(restaurantId: string, orderDocId: string): string {
  const rest = String(restaurantId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8)
  const order = String(orderDocId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  // Finatic constraint: <= 32 chars and alphanumeric only.
  return `FT${rest}${order}`.slice(0, 32)
}

function settlementMemberKey(data: Record<string, unknown>): string {
  return String(data.tab_settlement_member_session_id || '').trim()
}

/**
 * SECURE ORDER CREATION — Firestore access ONLY via Firebase Admin (bypasses client rules).
 */
export async function POST(req: Request) {
  const fs = adminDb()
  if (!fs) {
    return NextResponse.json({ error: ADMIN_NOT_CONFIGURED }, { status: 503 })
  }

  try {
    console.log('🛡️ SECURITY: API Route - Order creation request received')

    const body = await req.json()

    if ('customer_email' in body || 'customerEmail' in body) {
      console.error('🚨 SECURITY: Malicious field detected in request body')
      return NextResponse.json(
        { error: 'Malicious field detected: customer_email is not allowed' },
        { status: 400 }
      )
    }

    const resumeOrderId = body.resumeOrderId ? String(body.resumeOrderId).trim() : ''

    if (resumeOrderId) {
      if (!body.restaurantId || !body.tableNumber) {
        return NextResponse.json(
          { error: 'resumeOrderId requires restaurantId and tableNumber' },
          { status: 400 }
        )
      }
      const restaurantId = String(body.restaurantId).trim()
      const tableNumber = Number(body.tableNumber) || 0
      if (tableNumber <= 0) {
        return NextResponse.json({ error: 'Invalid tableNumber' }, { status: 400 })
      }
      if (body.paymentMethod !== 'card') {
        return NextResponse.json({ error: 'resumeOrderId is only valid for card payments' }, { status: 400 })
      }

      const snap = await fs.doc(orderPath(restaurantId, resumeOrderId)).get()
      if (!snap.exists) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 })
      }
      const d = snap.data() as Record<string, unknown>
      if (Number(d.table_number) !== tableNumber) {
        return NextResponse.json({ error: 'Order does not match this table' }, { status: 403 })
      }
      if (d.payment_method !== 'card') {
        return NextResponse.json({ error: 'Order is not a card payment' }, { status: 400 })
      }
      if (d.payment_status !== 'pending') {
        return NextResponse.json({ error: 'Order payment is not pending' }, { status: 400 })
      }
      if (d.payment_channel === 'terminal') {
        return NextResponse.json(
          { error: 'Order uses terminal payment; hosted checkout resume is not available' },
          { status: 400 }
        )
      }

      const docRefId = resumeOrderId
      const orderNumber = Number(d.order_number) || 0
      const total = Number(d.total)
      if (!Number.isFinite(total) || total <= 0) {
        return NextResponse.json({ error: 'Invalid order total' }, { status: 400 })
      }

      const merchantOrderNo = buildMerchantOrderNo(restaurantId, docRefId)

      const patchPayment = async (data: Record<string, unknown>) => {
        await fs.doc(orderPath(restaurantId, docRefId)).update(data)
      }

      try {
        console.log('[PayCloud] Sending merchant_order_no', {
          merchant_order_no: merchantOrderNo,
          length: merchantOrderNo.length,
          orderId: docRefId,
          flow: 'resume',
        })
        const payment = await createPaymentRequest({
          amount: total,
          orderId: merchantOrderNo,
          merchantNo: HOSTED_CHECKOUT_MERCHANT_NO,
          storeNo: HOSTED_CHECKOUT_STORE_NO,
          description: body.description || `FlashTap Table ${tableNumber} Order #${orderNumber}`,
        })

        await patchPayment({
          payment_reference: merchantOrderNo,
          paycloud_merchant_order_no: merchantOrderNo,
          payment_checkout_url: payment?.checkoutUrl || null,
          payment_status: 'pending',
          payment_pending_since: FieldValue.serverTimestamp(),
          payment_init_error: FieldValue.delete(),
        })

        return NextResponse.json({ orderId: docRefId, payment, checkoutUrl: payment?.checkoutUrl || null }, { status: 201 })
      } catch (paymentError: unknown) {
        logPayCloudInitFailure({ docRefId, merchantOrderNo }, paymentError)
        const msg =
          paymentError instanceof Error ? paymentError.message : 'PayCloud payment initialization failed'
        await patchPayment({
          payment_status: 'pending',
          payment_error: msg,
          payment_init_failed_at: FieldValue.serverTimestamp(),
        })
        return NextResponse.json(
          {
            orderId: docRefId,
            payment: null,
            checkoutUrl: null,
          },
          { status: 200 }
        )
      }
    }

    if (!body.restaurantId || !body.items?.length) {
      console.error('🚨 ORDER REJECTED: Invalid order payload', {
        hasRestaurantId: !!body.restaurantId,
        hasTableNumber: !!body.tableNumber,
        hasItems: !!body.items?.length,
      })
      return NextResponse.json(
        { error: 'Invalid order payload: restaurantId, tableNumber, and items are required' },
        { status: 400 }
      )
    }

    const sessionId = body.session_id ? String(body.session_id).trim() : undefined
    const restaurantId = String(body.restaurantId).trim()
    const tableNumber = Number(body.tableNumber) || 0
    const tabId = body.tab_id ? String(body.tab_id).trim() : null
    const memberSessionId = body.member_session_id ? String(body.member_session_id).trim() : null
    const tabSettlementForTabId = body.tab_settlement_for_tab_id
      ? String(body.tab_settlement_for_tab_id).trim()
      : null
    const tabSettlementMemberSessionId = body.tab_settlement_member_session_id
      ? String(body.tab_settlement_member_session_id).trim()
      : null

    if (!body.tableNumber || tableNumber <= 0) {
      console.error('🚨 ORDER REJECTED: tableNumber is required and must be > 0')
      return NextResponse.json(
        { error: 'tableNumber is required and must be a positive number' },
        { status: 400 }
      )
    }

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId cannot be empty' }, { status: 400 })
    }

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'items is required and must be a non-empty array' },
        { status: 400 }
      )
    }

    if (typeof body.total !== 'number' || body.total <= 0) {
      return NextResponse.json(
        { error: 'total is required and must be a positive number' },
        { status: 400 }
      )
    }

    const orderNumber = await getNextOrderNumberAdmin(restaurantId, fs)
    const resolvedPaymentMethod =
      body.paymentMethod === 'card' ? 'card' : body.paymentMethod === 'mobile_money' ? 'mobile_money' : 'cash'
    const initialPaymentStatus = resolvedPaymentMethod === 'cash' ? 'cash_pending' : 'pending'

    const rawPaymentChannel = body.paymentChannel ?? body.payment_channel
    const paymentChannelResolved: 'hosted' | 'terminal' | null =
      resolvedPaymentMethod === 'card'
        ? String(rawPaymentChannel || '')
            .trim()
            .toLowerCase() === 'terminal'
          ? 'terminal'
          : 'hosted'
        : null

    if (tabSettlementForTabId && resolvedPaymentMethod === 'card' && paymentChannelResolved === 'hosted') {
      const pendingSettlementRows = await fs
        .collection(ordersPath(restaurantId))
        .where('tab_settlement_for_tab_id', '==', tabSettlementForTabId)
        .where('payment_status', '==', 'pending')
        .limit(10)
        .get()

      const desiredMemberKey = tabSettlementMemberSessionId || ''
      const existingPending = pendingSettlementRows.docs.find((row) => {
        const data = row.data() as Record<string, unknown>
        const checkoutUrl = String(data.payment_checkout_url || '').trim()
        if (!checkoutUrl) return false
        return settlementMemberKey(data) === desiredMemberKey
      })

      if (existingPending) {
        const data = existingPending.data() as Record<string, unknown>
        const checkoutUrl = String(data.payment_checkout_url || '').trim()
        console.log('[ORDER] Reusing pending settlement order', {
          tab_id: tabSettlementForTabId,
          settlement_order_id: existingPending.id,
          member_session_id: desiredMemberKey || null,
        })
        return NextResponse.json(
          {
            orderId: existingPending.id,
            payment: { checkoutUrl },
            checkoutUrl,
            reusedSettlement: true,
          },
          { status: 200 }
        )
      }
    }

    const orderPayloadBase = {
      table_id: `table_${tableNumber}`,
      table_number: Number(tableNumber),
      session_id: sessionId || null,
      status: 'new' as const,
      payment_channel: paymentChannelResolved,
      payment_status: initialPaymentStatus as 'pending' | 'cash_pending',
      table_closed: false,
      is_closed: false,
      tab_id: tabId || null,
      member_session_id: memberSessionId || null,
      tab_settlement_for_tab_id: tabSettlementForTabId || null,
      tab_settlement_member_session_id: tabSettlementMemberSessionId || null,
      items: (body.items || []).map((item: any) => ({
        menu_item_id: String(item.menuItemId || item.menu_item_id || ''),
        name: String(item.name || ''),
        display_name: item.displayName ? String(item.displayName) : String(item.name || ''),
        quantity: Number(item.quantity) || 1,
        base_price: Number(item.basePrice || item.base_price || 0),
        subtotal: Number(item.subtotal || 0),
        size: item.size ? String(item.size) : null,
        selected_variants:
          item.selectedVariants && typeof item.selectedVariants === 'object'
            ? item.selectedVariants
            : {},
        addons: Array.isArray(item.addons)
          ? item.addons.map((a: any) => ({
              name: String(a.name || ''),
              price: Number(a.price || 0),
            }))
          : [],
        special_instructions:
          item.specialInstructions || item.special_instructions
            ? String(item.specialInstructions || item.special_instructions).trim()
            : null,
      })),
      subtotal: Number(body.subtotal) || 0,
      total: Number(body.total),
      payment_method: resolvedPaymentMethod as 'cash' | 'card' | 'mobile_money',
      order_instructions:
        body.orderInstructions && String(body.orderInstructions).trim()
          ? String(body.orderInstructions).trim()
          : null,
      source: 'qr_menu' as const,
      order_number: Number(orderNumber),
      payment_provider: body.paymentMethod === 'card' ? 'paycloud' : null,
    }

    const finalizedPayload = prepareForFirestore(orderPayloadBase)
    if (!finalizedPayload.table_number) {
      return NextResponse.json(
        { error: 'Order is missing required fields (table_number)' },
        { status: 400 }
      )
    }
    if (finalizedPayload.status !== 'new') {
      return NextResponse.json({ error: 'Order status must be "new"' }, { status: 400 })
    }

    const ref = await fs.collection(ordersPath(restaurantId)).add({
      ...finalizedPayload,
      created_at: FieldValue.serverTimestamp(),
      placed_at: FieldValue.serverTimestamp(),
    })
    const docRefId = ref.id
    console.log('✅ Order created (Firebase Admin):', docRefId)

    const patchPayment = async (data: Record<string, unknown>) => {
      await fs.doc(orderPath(restaurantId, docRefId)).update(data)
    }

    let payment: any = null
    if (resolvedPaymentMethod === 'card') {
      const merchantOrderNo = buildMerchantOrderNo(restaurantId, docRefId)

      if (paymentChannelResolved === 'terminal') {
        await patchPayment({
          payment_reference: merchantOrderNo,
          paycloud_merchant_order_no: merchantOrderNo,
          payment_status: 'pending',
        })
      } else {
        try {
          console.log('[PayCloud] Sending merchant_order_no', {
            merchant_order_no: merchantOrderNo,
            length: merchantOrderNo.length,
            orderId: docRefId,
            flow: 'create',
          })
          payment = await createPaymentRequest({
            amount: orderPayloadBase.total,
            orderId: merchantOrderNo,
            merchantNo: HOSTED_CHECKOUT_MERCHANT_NO,
            storeNo: HOSTED_CHECKOUT_STORE_NO,
            description: body.description || `FlashTap Table ${tableNumber} Order #${orderNumber}`,
          })

          await patchPayment({
            payment_reference: merchantOrderNo,
            paycloud_merchant_order_no: merchantOrderNo,
            payment_checkout_url: payment?.checkoutUrl || null,
            payment_status: 'pending',
            payment_pending_since: FieldValue.serverTimestamp(),
          })
        } catch (paymentError: unknown) {
          logPayCloudInitFailure({ docRefId, merchantOrderNo }, paymentError)
          const msg =
            paymentError instanceof Error ? paymentError.message : 'PayCloud payment initialization failed'
          await patchPayment({
            payment_status: 'pending',
            payment_error: msg,
            payment_init_failed_at: FieldValue.serverTimestamp(),
          })
          return NextResponse.json(
            {
              orderId: docRefId,
              payment: null,
              checkoutUrl: null,
            },
            { status: 200 }
          )
        }
      }
    }

    // Do not bump tab total for "pay full tab" settlement orders (they pay the balance, not add to it).
    if (tabId && !tabSettlementForTabId) {
      await fs.doc(tabPath(restaurantId, tabId)).update({
        total: FieldValue.increment(Number(orderPayloadBase.total) || 0),
        updated_at: FieldValue.serverTimestamp(),
      })
    }

    return NextResponse.json({ orderId: docRefId, payment, checkoutUrl: payment?.checkoutUrl || null }, { status: 201 })
  } catch (err: any) {
    console.error('❌ ORDER CREATION FAILURE:', err)
    if (err.message && err.message.includes('FORBIDDEN FIELD DETECTED')) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }

    const msg = String(err?.message || err || '')
    const code = err?.code
    const isPermissionDenied =
      code === 7 ||
      code === 'permission-denied' ||
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('permission denied')

    if (isPermissionDenied) {
      return NextResponse.json(
        {
          error:
            'Server Firestore permission denied. Use FIREBASE_SERVICE_ACCOUNT_JSON from the same Firebase project as NEXT_PUBLIC_FIREBASE_PROJECT_ID, add it on Vercel (Production + Preview), redeploy, and ensure the service account has Firestore access in Google Cloud IAM (e.g. roles include Cloud Datastore User).',
        },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { error: err.message || 'Failed to create order' },
      { status: 500 }
    )
  }
}
