import { NextResponse } from 'next/server'
import { queryPaymentOrder } from '@/payments/paycloud'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get('orderId')
  const merchantNo = searchParams.get('merchantNo') || undefined
  const storeNo = searchParams.get('storeNo') || undefined

  if (!orderId) {
    return NextResponse.json({ error: 'orderId required' })
  }

  try {
    const result = await queryPaymentOrder({ orderId, merchantNo, storeNo })
    return NextResponse.json({ result })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message, detail: err })
  }
}
