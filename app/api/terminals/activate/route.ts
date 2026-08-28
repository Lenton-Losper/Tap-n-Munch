import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { normalizeActivationCode } from '@/lib/terminals/activation-code'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
} from '@/lib/terminals/refresh-token'
import { signTerminalJwt } from '@/lib/terminals/terminal-jwt'
import {
  ACTIVATION_RATE_PERIOD_SECONDS,
  checkActivationRateLimit,
} from '@/lib/terminals/activation-rate-limit'

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
    /**
     * #241. BEFORE the body is read, so a flood costs us as little as possible per request.
     *
     * Fails OPEN when no binding is reachable -- local dev, jest, or a worker deployed before the
     * config lands. A misconfigured binding must not brick terminal activation for every device:
     * a venue that cannot activate a replacement terminal cannot trade, which is worse than the
     * hole this closes. The `unenforced` flag is logged so "allowed" and "not asked" are
     * distinguishable in the worker log rather than looking identical.
     */
    const rateLimit = await checkActivationRateLimit(request)
    if (!rateLimit.allowed) {
      console.warn('[terminals/activate] rate limited')
      return NextResponse.json(
        { error: 'Too many activation attempts. Wait a moment and try again.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimit.retryAfterSeconds || ACTIVATION_RATE_PERIOD_SECONDS) },
        },
      )
    }
    if (rateLimit.unenforced) {
      console.warn('[terminals/activate] rate limiting is NOT in force -- no binding reachable')
    }

    const body = (await request.json()) as Record<string, unknown>
    const rawCode = String(body?.code || '')
    const code = normalizeActivationCode(rawCode)
    const deviceId = readBodyString(body, 'deviceId', 'device_id')
    const terminalSn = readBodyString(body, 'terminalSn', 'terminal_sn', 'sn')

    if (!code) {
      return NextResponse.json({ error: 'Activation code is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const nowIso = new Date().toISOString()
    /**
     * TEMPORARY INSTRUMENTATION, 2026-08-28 -- four failed activation attempts on staging with
     * four different (wrong, unverified) explanations offered. Rather than a fifth hypothesis,
     * this logs and (behind an explicit opt-in header, never on by default) returns exactly what
     * was asked for: the raw code as received, the code after normalizeActivationCode, the
     * where-clause values the redemption query actually runs with, and -- separately from the
     * strict 3-condition query below -- whether ANY row exists for that normalized code at all,
     * ignoring active/expiry, so "no such code" is distinguishable from "code exists but already
     * active" or "code exists but expired" instead of collapsing all three into one 400. Remove
     * once the live cause is confirmed; do not let this rot in as permanent surface area.
     */
    const debugRequested = request.headers.get('x-debug-activation') === '1'

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, restaurant_id, device_id, name, activation_code_expires_at, active, activation_code')
      .eq('activation_code', code)
      .eq('active', false)
      .gt('activation_code_expires_at', nowIso)
      .maybeSingle()

    if (error) throw error

    if (!data?.id) {
      const { data: anyMatch } = await supabase
        .from('restaurant_terminals')
        .select('id, restaurant_id, terminal_name, status, active, activation_code, activation_code_expires_at')
        .eq('activation_code', code)
        .maybeSingle()

      console.error('[activate] no strict match', {
        rawCode,
        normalizedCode: code,
        whereClause: { activation_code: code, active: false, activation_code_expires_at_gt: nowIso },
        anyMatchIgnoringActiveAndExpiry: anyMatch ?? null,
      })

      return NextResponse.json({
        error: 'Invalid or expired activation code',
        ...(debugRequested
          ? {
              debug: {
                rawCode,
                normalizedCode: code,
                whereClause: { activation_code: code, active: false, activation_code_expires_at_gt: nowIso },
                anyMatchIgnoringActiveAndExpiry: anyMatch ?? null,
              },
            }
          : {}),
      }, { status: 400 })
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
