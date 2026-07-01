import { NextResponse } from 'next/server'

export function requireCronSecret(req: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[CRON] CRON_SECRET is not configured')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const provided = req.headers.get('x-cron-secret')
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}
