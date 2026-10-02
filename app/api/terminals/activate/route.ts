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
    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, restaurant_id, device_id, name, activation_code_expires_at, active, activation_code')
      .eq('activation_code', code)
      .eq('active', false)
      .gt('activation_code_expires_at', nowIso)
      .maybeSingle()

    if (error) throw error

    if (!data?.id) {
      /**
       * Deliberately says nothing about WHICH of the three conditions failed. This endpoint is
       * unauthenticated — anyone who can reach it can guess codes — so distinguishing "no such
       * code" from "code exists but is already active" would confirm a valid code to someone who
       * only guessed it.
       *
       * The temporary 2026-08-28 activation instrumentation that lived here has been removed. It
       * logged the raw submitted code and, behind an `x-debug-activation: 1` request header,
       * returned the matching terminal row — `activation_code` included — to any caller who set
       * the header. An opt-in flag on an unauthenticated route is not a safeguard: the opt-in
       * belongs to whoever is calling.
       */
      console.warn('[terminals/activate] no terminal matched an activation attempt')
      return NextResponse.json({ error: 'Invalid or expired activation code' }, { status: 400 })
    }

    const codeRestaurantId = String(data.restaurant_id)
    const codeTerminalId = String(data.id)
    const deviceSerial =
      deviceId || terminalSn || (data.device_id ? String(data.device_id) : null)

    const restaurantId = codeRestaurantId

    const refreshToken = generateRefreshToken()
    const refreshTokenHash = await hashRefreshToken(refreshToken)
    const refreshTokenExpiresAtValue = refreshTokenExpiresAt()

    const presentsIdentity = Boolean(deviceId || deviceSerial)
    let terminalId = codeTerminalId
    let updateData: { id: unknown; device_serial?: unknown; device_id?: unknown; sn?: unknown } | null = null

    if (presentsIdentity) {
      /**
       * ============================================================================================
       * A VALID ACTIVATION CODE IS SUFFICIENT. (Owner decision 2026-10-03; replaces F19.)
       * ============================================================================================
       *
       * The code names a restaurant; presenting it registers THIS physical device to that restaurant,
       * wherever the device was registered before. There is no manager approval, no transfer request
       * and no refusal because the device "belongs elsewhere".
       *
       * What stays absolute is that exactly ONE row holds a physical device identity. The whole change
       * is made by activate_terminal_by_code() in ONE transaction: it locks the code row and every row
       * holding the identity, RELEASES every other registration -- whichever restaurant they belong to -- and
       * binds exactly one row. The old restaurant's row is revoked, its identity and session cleared,
       * so its token can operate nothing. The unique indexes on device_id and device_serial are
       * untouched and remain the backstop for two activations racing.
       *
       * The function re-derives who holds the identity under its locks, so nothing read earlier in this request
       * (a decision made from a stale read) can put two restaurants on one device.
       */
      const { data: bound, error: bindError } = await supabase.rpc('activate_terminal_by_code', {
        p_code_terminal_id: codeTerminalId,
        p_device_id: deviceId,
        p_device_serial: deviceSerial,
        p_sn: terminalSn,
        p_refresh_token_hash: refreshTokenHash,
        p_refresh_token_expires_at: refreshTokenExpiresAtValue,
      })

      if (bindError) {
        const message = String((bindError as { message?: unknown }).message ?? '')
        const pgCode = (bindError as { code?: unknown }).code
        if (message.includes('ACTIVATION_CODE_INVALID')) {
          return NextResponse.json({ error: 'Invalid or expired activation code' }, { status: 400 })
        }
        if (pgCode === '23505' || pgCode === '40P01' || pgCode === '40001') {
          // Another activation of this same device landed in the same instant and took the identity
          // first. Nothing was written here; one owner remains. A retry lands cleanly.
          console.warn('[activate] concurrent activation of the same device; asking the device to retry', {
            codeTerminalId,
          })
          return NextResponse.json(
            { error: 'This device was being activated at the same moment. Tap Activate again.', code: 'ACTIVATION_CONFLICT' },
            { status: 409 },
          )
        }
        console.error('[activate] activate_terminal_by_code failed', bindError)
        return NextResponse.json(
          { error: 'Could not activate this terminal. Try again in a moment.', code: 'ACTIVATION_WRITE_FAILED' },
          { status: 503 },
        )
      }

      terminalId = String((bound as { terminalId?: unknown } | null)?.terminalId ?? '')
      if (!terminalId) throw new Error('activate_terminal_by_code returned no terminal id')

      const { data: row, error: rowError } = await supabase
        .from('restaurant_terminals')
        .select('id, restaurant_id, name, device_serial, device_id, sn')
        .eq('id', terminalId)
        .eq('restaurant_id', restaurantId)
        .single()
      if (rowError || !row?.id) {
        console.error('[activate] could not read the activated terminal', rowError)
        return NextResponse.json(
          { error: 'Could not activate this terminal. Try again in a moment.', code: 'ACTIVATION_WRITE_FAILED' },
          { status: 503 },
        )
      }
      updateData = row
    } else {
      // No device identity presented (an older app): there is nothing for another row to hold, so the
      // code's own row is simply activated.
      const { data: row, error: updateError } = await supabase
        .from('restaurant_terminals')
        .update({
          active: true,
          status: 'active',
          activated_at: nowIso,
          last_seen_at: nowIso,
          activation_code: null,
          activation_code_expires_at: null,
          refresh_token_hash: refreshTokenHash,
          refresh_token_expires_at: refreshTokenExpiresAtValue,
          ...(terminalSn ? { sn: terminalSn } : {}),
        })
        .eq('id', terminalId)
        .eq('restaurant_id', restaurantId)
        .select('id, restaurant_id, name, device_serial, device_id, sn')
        .single()
      if (updateError || !row?.id) {
        console.error('[activate] terminal update failed', updateError)
        return NextResponse.json(
          { error: 'Could not activate this terminal. Try again in a moment.', code: 'ACTIVATION_WRITE_FAILED' },
          { status: 503 },
        )
      }
      updateData = row
    }

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('name, finatic_merchant_no, finatic_store_no')
      .eq('id', restaurantId)
      .single()

    if (restaurantError) throw restaurantError

    const resolvedDeviceSerial =
      deviceSerial ||
      (updateData?.device_serial ? String(updateData.device_serial) : '') ||
      (updateData?.device_id ? String(updateData.device_id) : '') ||
      (updateData?.sn ? String(updateData.sn) : '')

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
    /**
     * THE MESSAGE THE READER GETS IS NEVER THE DATABASE'S.
     *
     * This used to be `error instanceof Error ? error.message : 'Failed to activate terminal'`.
     * A PostgREST error is a plain object, so every database refusal took the fallback branch and
     * arrived at the P5 as "Failed to activate terminal" -- indistinguishable from a bug, an
     * outage, or a constraint doing its job. Diagnosing it needed a rolled-back SQL reproduction.
     *
     * The diagnosis is logged in full; the caller gets something it can act on, with no constraint
     * name, column or row id in it. Those describe our schema to an UNAUTHENTICATED endpoint, and
     * the reader cannot act on them anyway.
     */
    console.error('[activate] failed:', error)
    return NextResponse.json(
      {
        error: 'Could not activate this terminal. Try again, or reissue the code.',
        code: 'ACTIVATION_FAILED',
      },
      { status: 500 },
    )
  }
}
