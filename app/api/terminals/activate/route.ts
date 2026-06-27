import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { normalizeActivationCode } from '@/lib/terminals/activation-code'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from '@/lib/terminals/refresh-token'
import { signTerminalJwt } from '@/lib/terminals/terminal-jwt'

export const dynamic = 'force-dynamic'

function readBodyString(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body?.[key]
    if (value != null && String(value).trim()) {
      return String(value).trim()
    }
  }
  return null
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const code = normalizeActivationCode(String(body?.code || ''))
    const deviceId = readBodyString(body, 'deviceId', 'device_id')
    const terminalSn = readBodyString(body, 'terminalSn', 'terminal_sn', 'sn')

    console.log('[activate] code received:', code)

    if (!code) {
      return NextResponse.json({ error: 'Activation code is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const nowIso = new Date().toISOString()

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, restaurant_id, device_id, name, activation_code_expires_at, active, activation_code')
      .eq('activation_code', code)
      .eq('active', false)
      .gt('activation_code_expires_at', nowIso)
      .maybeSingle()

    console.log('[activate] lookup result:', data, error)

    if (error) throw error

    if (!data?.id) {
      return NextResponse.json({ error: 'Invalid or expired activation code' }, { status: 400 })
    }

    const restaurantId = String(data.restaurant_id)
    const terminalId = String(data.id)
    const deviceSerial =
      deviceId || terminalSn || (data.device_id ? String(data.device_id) : null)

    const refreshToken = generateRefreshToken()
    const refreshTokenHash = await hashRefreshToken(refreshToken)
    const refreshTokenExpiresAtValue = refreshTokenExpiresAt()

    const updates: Record<string, unknown> = {
      active: true,
      status: 'active',
      activated_at: nowIso,
      last_seen_at: nowIso,
      activation_code: null,
      activation_code_expires_at: null,
      refresh_token_hash: refreshTokenHash,
      refresh_token_expires_at: refreshTokenExpiresAtValue,
    }

    if (deviceId) {
      updates.device_id = deviceId
    }

    if (terminalSn) {
      updates.sn = terminalSn
    }

    if (deviceSerial) {
      updates.device_serial = deviceSerial
    }

    const { data: updateData, error: updateError } = await supabase
      .from('restaurant_terminals')
      .update(updates)
      .eq('id', terminalId)
      .eq('restaurant_id', restaurantId)
      .select('id, restaurant_id, name, device_serial, device_id, sn')
      .single()

    console.log('[activate] update result:', updateData, updateError)

    if (updateError || !updateData?.id) {
      throw updateError || new Error('Failed to activate terminal')
    }

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('name, finatic_merchant_no, finatic_store_no')
      .eq('id', restaurantId)
      .single()

    if (restaurantError) throw restaurantError

    const resolvedDeviceSerial =
      deviceSerial ||
      (updateData.device_serial ? String(updateData.device_serial) : '') ||
      (updateData.device_id ? String(updateData.device_id) : '') ||
      (updateData.sn ? String(updateData.sn) : '')

    const finalDeviceSerial = resolvedDeviceSerial || `ft-${terminalId}`

    if (!finalDeviceSerial) {
      throw new Error('Unable to resolve device serial for terminal token')
    }

    if (!resolvedDeviceSerial) {
      await supabase
        .from('restaurant_terminals')
        .update({ device_serial: `ft-${terminalId}` })
        .eq('id', terminalId)
    }

    const accessToken = await signTerminalJwt({
      terminal_id: terminalId,
      restaurant_id: restaurantId,
      device_serial: finalDeviceSerial,
    })

    return NextResponse.json({
      accessToken,
      refreshToken,
      restaurant_id: restaurantId,
      terminal_id: terminalId,
      restaurant_name: restaurant?.name,
      merchantNo: restaurant?.finatic_merchant_no,
      storeNo: restaurant?.finatic_store_no,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to activate terminal'
    console.error('[activate] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
