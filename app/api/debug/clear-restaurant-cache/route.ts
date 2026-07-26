import { getRedis } from '@/lib/redis'
import { NextResponse } from 'next/server'
import { requireStagingPlatformAdmin } from '@/lib/api/require-staging-platform-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const denied = await requireStagingPlatformAdmin(request)
  if (denied) return denied

  const keys = await getRedis().keys('restaurant:*')
  if (keys.length > 0) {
    await Promise.all(keys.map((k) => getRedis().del(k)))
  }
  return NextResponse.json({
    cleared: keys,
    count: keys.length,
  })
}
