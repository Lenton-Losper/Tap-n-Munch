import { redis } from '@/lib/redis'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const keys = await redis.keys('restaurant:*')
  if (keys.length > 0) {
    await Promise.all(keys.map((k) => redis.del(k)))
  }
  return NextResponse.json({
    cleared: keys,
    count: keys.length,
  })
}
