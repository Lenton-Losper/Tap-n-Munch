import { NextResponse } from 'next/server'
import { orderPath } from '@/lib/firebase/paths'
import { FieldValue, adminDb } from '@/lib/firebase/admin-firestore'
import { queryPaymentOrder } from '@/payments/paycloud'

const ADMIN_NOT_CONFIGURED =
  'Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel) to environment variables and redeploy.'

function toMoney(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

async function loadOrders(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  restaurantId: string,
  orderIds: string[]
) {
  const rows: Array<{ orderId: string; data: Record<string, unknown> }> = []
  for (const orderId of orderIds) {
    const snap = await fs.doc(orderPath(restaurantId, orderId)).get()
    if (!snap.exists) {
      throw new Error(`Order not found: ${orderId}`)
    }
    rows.push({ orderId, data: (snap.data() || {}) as Record<string, unknown> })
  }
  return rows
}

export async function POST(req: Request) {
  const fs = adminDb()
  if (!fs) {
    return NextResponse.json({ ok: false, error: ADMIN_NOT_CONFIGURED }, { status: 503 })
  }

  try {
    const body = await req.json()
    const restaurantId = String(body.restaurantId || '').trim()
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const merchantOrderNoRaw = String(body.merchantOrderNo || '').trim()

    if (!restaurantId || orderIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'restaurantId and orderIds are required' }, { status: 400 })
    }

    const rows = await loadOrders(fs, restaurantId, orderIds)
    if (rows.every((r) => r.data.payment_status === 'paid')) {
      return NextResponse.json({ ok: true, paid: true, source: 'firestore' }, { status: 200 })
    }

    const expectedAmount = Math.round(rows.reduce((s, r) => s + (Number(r.data.total) || 0), 0) * 100) / 100
    const merchantOrderNo =
      merchantOrderNoRaw ||
      (orderIds.length === 1 ? `${restaurantId}:${orderIds[0]}` : `${restaurantId}:receipt:${orderIds.join(',')}`)

    const query = await queryPaymentOrder({ orderId: merchantOrderNo })
    const raw = query.rawResponse || {}

    // Finatic returns `data` as a JSON string; parse before checking trans_status.
    let orderData: unknown = (raw as Record<string, unknown>)?.data
    if (typeof orderData === 'string') {
      try {
        orderData = JSON.parse(orderData)
      } catch {
        console.warn('[RECONCILE] Failed to parse order data string')
      }
    }

    const transStatus =
      (orderData as Record<string, unknown> | null)?.trans_status ??
      (raw as Record<string, unknown>)?.trans_status
    console.log(
      '[RECONCILE] trans_status=',
      transStatus,
      'orderData=',
      JSON.stringify(orderData ?? null)
    )

    const paid =
      transStatus === 2 ||
      transStatus === '2' ||
      ['paid', 'success', 'succeeded'].includes(
        String(
          (orderData as Record<string, unknown> | null)?.trade_status ??
            (orderData as Record<string, unknown> | null)?.status ??
            (raw as Record<string, unknown>)?.trade_status ??
            (raw as Record<string, unknown>)?.status ??
            ''
        ).toLowerCase()
      )

    if (!paid) {
      const statusText = String(
        (orderData as Record<string, unknown> | null)?.trade_status ??
          (orderData as Record<string, unknown> | null)?.status ??
          (raw as Record<string, unknown>)?.trade_status ??
          (raw as Record<string, unknown>)?.status ??
          transStatus ??
          'unknown'
      ).toLowerCase()
      return NextResponse.json(
        { ok: true, paid: false, source: 'query', status: statusText || 'unknown', merchantOrderNo },
        { status: 200 }
      )
    }

    const paidAmount = toMoney(
      (orderData as Record<string, unknown> | null)?.amount ??
        (orderData as Record<string, unknown> | null)?.order_amount ??
        (orderData as Record<string, unknown> | null)?.paid_amount ??
        (raw as Record<string, unknown>)?.amount ??
        (raw as Record<string, unknown>)?.order_amount ??
        (raw as Record<string, unknown>)?.paid_amount
    )
    if (paidAmount !== null && Math.abs(paidAmount - expectedAmount) > 0.02) {
      return NextResponse.json(
        {
          ok: false,
          paid: false,
          error: `Amount mismatch. Expected ${expectedAmount.toFixed(2)}, got ${paidAmount.toFixed(2)}`,
        },
        { status: 409 }
      )
    }

    const patch = {
      payment_status: 'paid' as const,
      paid_at: FieldValue.serverTimestamp(),
      payment_provider: 'paycloud',
      paycloud_transaction_id: String(raw.psn || raw.transaction_id || '') || null,
      updated_at: FieldValue.serverTimestamp(),
    }
    for (const { orderId } of rows) {
      await fs.doc(orderPath(restaurantId, orderId)).update(patch)
    }

    return NextResponse.json({ ok: true, paid: true, source: 'query', merchantOrderNo }, { status: 200 })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to reconcile payment'
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
