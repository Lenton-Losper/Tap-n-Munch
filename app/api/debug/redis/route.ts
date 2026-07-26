import { NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'
import { requireStagingPlatformAdmin } from '@/lib/api/require-staging-platform-admin'

export async function GET(request: Request) {
  const denied = await requireStagingPlatformAdmin(request)
  if (denied) return denied

  try {
    await getRedis().set('test-key', 'FlashTap Redis working!')
    const value = await getRedis().get('test-key')
    await getRedis().del('test-key')

    return NextResponse.json({
      success: true,
      message: value,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: String(err),
      },
      { status: 500 },
    )
  }
}
