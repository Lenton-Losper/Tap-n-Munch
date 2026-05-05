import { NextResponse } from 'next/server'
import { redis } from '@/lib/redis'

export async function GET() {
  try {
    await redis.set('test-key', 'FlashTap Redis working!')
    const value = await redis.get('test-key')
    await redis.del('test-key')

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
      { status: 500 }
    )
  }
}
