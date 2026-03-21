import { NextResponse } from 'next/server'
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { orderPath } from '@/lib/firebase/paths'
import { enforceWebhookRateLimit, handlePaycloudWebhook } from '@/payments/webhook'

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

export async function POST(req: Request) {
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
      if (!parsedRef || !db) return

      const patch = {
        payment_status: 'paid' as const,
        paid_at: serverTimestamp(),
        payment_provider: 'paycloud',
        paycloud_transaction_id: ref.transactionId || null,
        updated_at: serverTimestamp(),
      }

      if (parsedRef.mode === 'receipt') {
        for (const orderId of parsedRef.orderIds) {
          await updateDoc(doc(db, orderPath(parsedRef.restaurantId, orderId)), patch)
        }
        console.log('[PayCloud webhook] Receipt payment — orders marked paid:', {
          restaurantId: parsedRef.restaurantId,
          orderIds: parsedRef.orderIds,
          transactionId: ref.transactionId,
        })
      } else {
        await updateDoc(doc(db, orderPath(parsedRef.restaurantId, parsedRef.orderId)), patch)
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
