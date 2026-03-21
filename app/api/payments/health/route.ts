import { NextResponse } from 'next/server'
import { checkPaycloudHealth } from '@/payments/paycloud'

export async function GET() {
  const status = await checkPaycloudHealth()
  return NextResponse.json(
    {
      service: 'paycloud',
      ok: status.ok,
      status: status.status,
      endpoint: status.endpoint,
      error: status.error || null,
      timestamp: new Date().toISOString(),
    },
    { status: status.ok ? 200 : 503 }
  )
}
