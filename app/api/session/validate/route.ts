import { NextResponse } from 'next/server'
import { validateSessionToken } from '@/lib/session-token'

export async function POST(req: Request) {
  try {
    const { token } = await req.json()

    if (!token) {
      return NextResponse.json({ valid: false, reason: 'No token' }, { status: 410 })
    }

    const result = await validateSessionToken(token)

    if (!result.valid) {
      return NextResponse.json(
        { valid: false, reason: result.reason },
        { status: 410 }
      )
    }

    return NextResponse.json({ valid: true })
  } catch (err) {
    return NextResponse.json({ valid: false, reason: 'Server error' }, { status: 410 })
  }
}
