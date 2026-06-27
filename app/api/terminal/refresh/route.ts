import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from '@/lib/terminals/refresh-token'
import { signTerminalJwt } from '@/lib/terminals/terminal-jwt'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const refreshToken = body?.refreshToken ? String(body.refreshToken).trim() : ''

    if (!refreshToken) {
      return NextResponse.json({ error: 'Missing refresh token' }, { status: 401 })
    }

    const hash = await hashRefreshToken(refreshToken)
    const supabase = createServerSupabaseClient()

    const { data: terminal, error } = await supabase
      .from('restaurant_terminals')
      .select('id, status, restaurant_id, device_serial, refresh_token_expires_at')
      .eq('refresh_token_hash', hash)
      .single()

    if (error || !terminal) {
      return NextResponse.json({ error: 'Invalid refresh token' }, { status: 401 })
    }

    if (terminal.status !== 'active') {
      return NextResponse.json({ error: 'Terminal is not active' }, { status: 403 })
    }

    const expiresAt = terminal.refresh_token_expires_at
      ? new Date(String(terminal.refresh_token_expires_at))
      : null

    if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt < new Date()) {
      return NextResponse.json({ error: 'Refresh token expired' }, { status: 401 })
    }

    const newRefreshToken = generateRefreshToken()
    const newHash = await hashRefreshToken(newRefreshToken)
    const newExpiry = refreshTokenExpiresAt()

    const { error: rotateError } = await supabase
      .from('restaurant_terminals')
      .update({
        refresh_token_hash: newHash,
        refresh_token_expires_at: newExpiry,
      })
      .eq('id', terminal.id)

    if (rotateError) {
      return NextResponse.json({ error: 'Refresh failed' }, { status: 500 })
    }

    const deviceSerial = terminal.device_serial ? String(terminal.device_serial) : ''
    if (!deviceSerial) {
      return NextResponse.json({ error: 'Terminal device serial missing' }, { status: 500 })
    }

    const accessToken = await signTerminalJwt({
      terminal_id: String(terminal.id),
      restaurant_id: String(terminal.restaurant_id),
      device_serial: deviceSerial,
    })

    return NextResponse.json({
      accessToken,
      refreshToken: newRefreshToken,
    })
  } catch {
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 })
  }
}
