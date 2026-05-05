import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const supabase = createServerSupabaseClient()
  const body = await req.json().catch(() => ({}))
  const status = body?.status as string | undefined
  const paymentStatus = body?.payment_status as string | undefined
  const { orderId } = await params

  if (!status && !paymentStatus) {
    return NextResponse.json({ error: 'status or payment_status required' }, { status: 400 })
  }

  const patch: Record<string, string> = {}
  if (status) patch.status = status
  if (paymentStatus) patch.payment_status = paymentStatus

  const { error } = await supabase.from('orders').update(patch).eq('id', orderId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
