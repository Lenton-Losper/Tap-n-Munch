import { NextResponse } from 'next/server'
import { orderPath } from '@/lib/firebase/paths'
import { FieldValue, adminDb } from '@/lib/firebase/admin-firestore'

const ADMIN_NOT_CONFIGURED =
  'Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel) to environment variables and redeploy.'

function sessionMatchesOrder(clientSession: string, data: Record<string, unknown>): boolean {
  const s = String(clientSession || '').trim()
  if (!s) return false
  const sid = String(data.session_id || '').trim()
  const mid = String(data.member_session_id || '').trim()
  if (sid && s === sid) return true
  if (mid && s === mid) return true
  return false
}

export async function POST(req: Request, context: { params: Promise<{ orderId: string }> }) {
  const fs = adminDb()
  if (!fs) {
    return NextResponse.json({ error: ADMIN_NOT_CONFIGURED }, { status: 503 })
  }

  const { orderId } = await context.params
  const trimmedOrderId = String(orderId || '').trim()
  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const restaurantId = String(body.restaurantId ?? '').trim()
  const sessionId = String(body.session_id ?? body.sessionId ?? '').trim()
  if (!restaurantId) {
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
  }
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id is required' }, { status: 400 })
  }

  const ref = fs.doc(orderPath(restaurantId, trimmedOrderId))
  const snap = await ref.get()
  if (!snap.exists) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const data = snap.data() as Record<string, unknown>
  if (!sessionMatchesOrder(sessionId, data)) {
    return NextResponse.json({ error: 'Order does not belong to this session' }, { status: 403 })
  }

  if (String(data.payment_channel || '').trim().toLowerCase() !== 'terminal') {
    return NextResponse.json({ error: 'Order is not a terminal card payment' }, { status: 400 })
  }

  const nowIso = new Date().toISOString()
  await ref.update({
    status: 'ready_for_terminal',
    ready_for_terminal_at: nowIso,
    updated_at: FieldValue.serverTimestamp(),
  })

  return NextResponse.json({ success: true, orderId: trimmedOrderId, ready_for_terminal_at: nowIso })
}
