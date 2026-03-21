import { NextResponse } from 'next/server'
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

  console.log('[PayCloud webhook] Incoming payload:', rawBody)

  const result = await handlePaycloudWebhook(rawBody, headers, {
    onPaid: async (_payload: any, ref: any) => {
      const parsedRef = parseMerchantOrderNo(ref.orderId)
      if (!parsedRef) return

      if (parsedRef.mode === 'receipt') {
        await markOrdersPaid(fs, parsedRef.restaurantId, parsedRef.orderIds, ref.transactionId || null)
        console.log('[PayCloud webhook] Receipt payment — orders marked paid:', {
          restaurantId: parsedRef.restaurantId,
          orderIds: parsedRef.orderIds,
          transactionId: ref.transactionId,
        })
      } else {
        await markOrdersPaid(fs, parsedRef.restaurantId, [parsedRef.orderId], ref.transactionId || null)
        console.log('[PayCloud webhook] Payment confirmed and order updated:', {
          restaurantId: parsedRef.restaurantId,
          orderId: parsedRef.orderId,
          transactionId: ref.transactionId,
        })
      }
    },
    onEvent: async (_payload: any, ref: any) => {
      console.log('[PayCloud webhook] Event received:', ref)
    },
  })

  return NextResponse.json(result.body, { status: result.status })
}
