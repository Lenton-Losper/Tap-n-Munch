import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { buildDashboardPayload } from '@/lib/platform/dashboard'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const payload = await buildDashboardPayload()
    return NextResponse.json(payload)
  } catch (err) {
    console.error('[platform/dashboard]', err)
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 })
  }
}
