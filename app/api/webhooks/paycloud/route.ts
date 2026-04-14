import { NextResponse } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { orderPath } from '@/lib/firebase/paths'
import { enforceWebhookRateLimit } from '@/payments/webhook'
import { verifyPayloadSignature } from '@/payments/signature'
import { FieldValue, adminDb } from '@/lib/firebase/admin-firestore'
import type { DocumentReference } from 'firebase-admin/firestore'

const ADMIN_NOT_CONFIGURED =
  'Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel) to environment variables and redeploy.'

function webhookAck() {
  console.log('[WEBHOOK] Sending response: success')
  return new Response('success', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}

function getClientIp(req: Request) {
  return req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown'
}

function extractSign(payload: Record<string, unknown>, headers: Headers): string {
  const h =
    headers.get('x-paycloud-sign') ||
    headers.get('paycloud-sign') ||
    headers.get('x-signature') ||
    ''
  if (h) return h
  const b = payload?.sign
  return typeof b === 'string' ? b : ''
}

function isPaidTransStatus(transStatus: unknown): boolean {
  if (transStatus === 2 || transStatus === '2') return true
  const s = String(transStatus ?? '').toLowerCase()
  return s === 'paid' || s === 'success' || s === 'succeeded'
}

async function resolveOrderRefs(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  merchantOrderNo: string
): Promise<DocumentReference[]> {
  const m = String(merchantOrderNo || '').trim()
  if (!m) return []

  const restaurantsSnap = await fs.collection('restaurants').get()
  const restaurantIds = restaurantsSnap.docs.map((d) => d.id)

  const results = await Promise.all(
    restaurantIds.map(async (restaurantId) => {
      const directRef = fs.doc(`restaurants/${restaurantId}/orders/${m}`)
      const directSnap = await directRef.get()
      if (directSnap.exists) return [directRef]

      const byMerchantOrderNo = await fs
        .collection(`restaurants/${restaurantId}/orders`)
        .where('paycloud_merchant_order_no', '==', m)
        .limit(5)
        .get()
      if (!byMerchantOrderNo.empty) return byMerchantOrderNo.docs.map((d) => d.ref)

      return [] as DocumentReference[]
    })
  )

  const firstNonEmpty = results.find((refs) => refs.length > 0)
  if (firstNonEmpty && firstNonEmpty.length > 0) return firstNonEmpty

  const colon = m.indexOf(':')
  if (colon <= 0) return []
  const restaurantId = m.slice(0, colon)
  const rest = m.slice(colon + 1)
  if (!restaurantId || !rest) return []

  if (rest.startsWith('receipt:')) {
    const idsPart = rest.slice('receipt:'.length).split('@')[0] ?? ''
    const orderIds = idsPart
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    const refs: DocumentReference[] = []
    for (const oid of orderIds) {
      const ref = fs.doc(orderPath(restaurantId, oid))
      const snap = await ref.get()
      if (snap.exists) refs.push(ref)
    }
    return refs
  }

  const ref = fs.doc(orderPath(restaurantId, rest))
  const snap = await ref.get()
  return snap.exists ? [ref] : []
}

export async function POST(req: Request) {
  const fs = adminDb()
  if (!fs) {
    return NextResponse.json({ success: false, error: ADMIN_NOT_CONFIGURED }, { status: 503 })
  }

  console.log('[WEBHOOK] Headers:', Object.fromEntries(req.headers.entries()))

  const rate = enforceWebhookRateLimit(getClientIp(req))
  if (!rate.allowed) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })
  }

  const rawBody = await req.text()
  console.log('[WEBHOOK] Raw body:', rawBody)
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
    console.log('[WEBHOOK] Parsed body:', JSON.stringify(payload, null, 2))
  } catch {
    console.warn('[PayCloud webhook] Invalid JSON body')
    return webhookAck()
  }

  const sign = extractSign(payload, req.headers)
  if (sign) {
    try {
      const copy = { ...payload }
      const ok = verifyPayloadSignature(copy, sign)
      if (!ok) {
        console.warn('[PayCloud webhook] Signature verification failed; continuing without rejecting request')
      }
    } catch (e) {
      console.warn('[PayCloud webhook] Signature verification error; continuing', e)
    }
  } else {
    console.warn('[PayCloud webhook] No signature on payload or headers')
  }

  const merchant_order_no = String(
    payload.merchant_order_no ?? payload.out_trade_no ?? payload.order_id ?? ''
  ).trim()
  const trans_status = payload.trans_status ?? payload.trade_status ?? payload.status
  const order_amount = payload.order_amount ?? payload.amount ?? payload.paid_amount
  const trans_no =
    payload.trans_no ?? payload.transaction_id ?? payload.tn ?? payload.psn ?? null

  if (!merchant_order_no) {
    return webhookAck()
  }

  if (typeof order_amount !== 'undefined') {
    console.log('[PayCloud webhook] order_amount', order_amount)
  }

  if (!isPaidTransStatus(trans_status)) {
    console.log(
      '[WEBHOOK] Not a paid status, ignoring. trans_status=',
      trans_status,
      'full payload=',
      JSON.stringify(payload)
    )
    return webhookAck()
  }

  const refs = await resolveOrderRefs(fs, merchant_order_no)
  if (refs.length === 0) {
    console.warn('[PayCloud webhook] No Firestore order for merchant_order_no', merchant_order_no)
    return webhookAck()
  }

  const paidAt = Timestamp.fromDate(new Date())
  const transNoStr = trans_no != null ? String(trans_no) : null

  await Promise.all(
    refs.map((ref) =>
      ref.update({
        payment_status: 'paid',
        payment_trans_no: transNoStr,
        is_closed: false,
        paid_at: paidAt,
        payment_provider: 'paycloud',
        updated_at: FieldValue.serverTimestamp(),
      })
    )
  )

  console.log('[PayCloud webhook] Marked paid', {
    merchant_order_no,
    trans_no: transNoStr,
    refs: refs.length,
  })

  return webhookAck()
}

export async function GET(req: Request) {
  console.log('[WEBHOOK] GET request received - URL verification')
  console.log('[WEBHOOK] GET headers:', Object.fromEntries(req.headers.entries()))
  console.log('[WEBHOOK] GET url:', req.url)
  return new Response('success', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}
