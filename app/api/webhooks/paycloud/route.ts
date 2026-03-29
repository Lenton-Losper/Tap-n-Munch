import { NextResponse } from 'next/server'
import { FieldPath } from 'firebase-admin/firestore'
import { orderPath } from '@/lib/firebase/paths'
import { enforceWebhookRateLimit, handlePaycloudWebhook } from '@/payments/webhook'
import { FieldValue, adminDb } from '@/lib/firebase/admin-firestore'

const ADMIN_NOT_CONFIGURED =
  'Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel) to environment variables and redeploy.'

function getClientIp(req: Request) {
  return req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown'
}

type ParsedMerchantOrder =
  | { mode: 'single'; restaurantId: string; orderId: string }
  | { mode: 'receipt'; restaurantId: string; orderIds: string[] }

function parseMerchantOrderNo(merchantOrderNo: string): ParsedMerchantOrder | null {
  const s = String(merchantOrderNo || '').trim()
  const i = s.indexOf(':')
  if (i < 0) return null
  const restaurantId = s.slice(0, i)
  const rest = s.slice(i + 1)
  if (!restaurantId || !rest) return null

  if (rest.startsWith('receipt:')) {
    const idsPart = rest.slice('receipt:'.length)
    const orderIds = idsPart
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (!orderIds.length) return null
    return { mode: 'receipt', restaurantId, orderIds }
  }

  return { mode: 'single', restaurantId, orderId: rest }
}

async function resolveRestaurantForOrderId(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  orderId: string
): Promise<{ restaurantId: string } | null> {
  const snap = await fs.collectionGroup('orders').where(FieldPath.documentId(), '==', orderId).limit(5).get()
  if (snap.empty) return null
  const parent = snap.docs[0].ref.parent.parent
  const restaurantId = parent?.id
  if (!restaurantId) return null
  return { restaurantId }
}

/** Resolves gateway `merchant_order_no` (wire format: bare id or comma-separated receipt ids). */
async function resolveMerchantOrderForWebhook(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  merchantOrderNo: string
): Promise<ParsedMerchantOrder | null> {
  const colonFormat = parseMerchantOrderNo(merchantOrderNo)
  if (colonFormat) return colonFormat

  const s = String(merchantOrderNo || '').trim()
  if (!s) return null

  if (s.includes(',')) {
    const orderIds = s.split(',').map((x) => x.trim()).filter(Boolean)
    if (orderIds.length === 0) return null
    const resolved = await resolveRestaurantForOrderId(fs, orderIds[0])
    if (!resolved) return null
    return { mode: 'receipt', restaurantId: resolved.restaurantId, orderIds }
  }

  const resolved = await resolveRestaurantForOrderId(fs, s)
  if (!resolved) return null
  return { mode: 'single', restaurantId: resolved.restaurantId, orderId: s }
}

async function markOrdersPaid(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  restaurantId: string,
  orderIds: string[],
  transactionId: string | null
) {
  const patch = {
    payment_status: 'paid' as const,
    paid_at: FieldValue.serverTimestamp(),
    payment_provider: 'paycloud',
    paycloud_transaction_id: transactionId || null,
    updated_at: FieldValue.serverTimestamp(),
  }

  for (const orderId of orderIds) {
    await fs.doc(orderPath(restaurantId, orderId)).update(patch)
  }
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

function toMoney(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

async function verifyAmountAndMarkPaid(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  parsedRef: ParsedMerchantOrder,
  ref: any
) {
  const orderIds = parsedRef.mode === 'receipt' ? parsedRef.orderIds : [parsedRef.orderId]
  const rows = await loadOrders(fs, parsedRef.restaurantId, orderIds)

  const allPaid = rows.every((r) => r.data.payment_status === 'paid')
  if (allPaid) {
    return { alreadyPaid: true }
  }

  const expectedAmount = Math.round(
    rows.reduce((sum, r) => sum + (Number(r.data.total) || 0), 0) * 100
  ) / 100
  const webhookAmount = toMoney(ref.paidAmount)
  if (webhookAmount === null || Math.abs(expectedAmount - webhookAmount) > 0.02) {
    throw new Error(
      `Webhook amount mismatch for ${ref.orderId}: expected ${expectedAmount.toFixed(2)}, got ${String(
        ref.paidAmount
      )}`
    )
  }

  await markOrdersPaid(fs, parsedRef.restaurantId, orderIds, ref.transactionId || null)
  return { alreadyPaid: false, expectedAmount, webhookAmount }
}

export async function POST(req: Request) {
  const fs = adminDb()
  if (!fs) {
    return NextResponse.json({ ok: false, error: ADMIN_NOT_CONFIGURED }, { status: 503 })
  }

  const rate = enforceWebhookRateLimit(getClientIp(req))
  if (!rate.allowed) {
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 })
  }

  const rawBody = await req.text()
  const headers = Object.fromEntries(req.headers.entries())
  const processing = handlePaycloudWebhook(rawBody, headers, {
    onPaid: async (_payload: any, ref: any) => {
      const parsedRef = await resolveMerchantOrderForWebhook(fs, ref.orderId)
      if (!parsedRef) return

      const processed = await verifyAmountAndMarkPaid(fs, parsedRef, ref)
      if (processed.alreadyPaid) {
        console.log('[PayCloud webhook] Duplicate paid notification acknowledged', {
          merchantOrderNo: ref.orderId,
          transactionId: ref.transactionId,
        })
        return
      }

      console.log('[PayCloud webhook] Payment confirmed and orders updated', {
        merchantOrderNo: ref.orderId,
        mode: parsedRef.mode,
        transactionId: ref.transactionId,
        amount: processed.webhookAmount,
      })
    },
    onEvent: async (_payload: any, ref: any) => {
      console.log('[PayCloud webhook] Event received', {
        orderId: ref.orderId,
        status: ref.status,
        transactionId: ref.transactionId,
      })
    },
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Webhook processing failed'
    console.error('[PayCloud webhook] Processing failed', { message })
    return { status: 500, body: { ok: false, error: message } }
  })

  const FAST_ACK_MS = 4500
  const timeout = new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    setTimeout(() => resolve({ status: 200, body: { ok: true, accepted: true, deferred: true } }), FAST_ACK_MS)
  })

  const result = await Promise.race([processing, timeout])
  return NextResponse.json(result.body, { status: result.status })
}
