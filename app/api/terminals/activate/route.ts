import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { normalizeActivationCode } from '@/lib/terminals/activation-code'
import {
  ACTIVATION_REFUSALS,
  resolveActivationTarget,
  type IdentityHolder,
} from '@/lib/terminals/resolve-activation-target'
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
import {
  ACTIVATION_TRANSFER_REQUESTED_AGAIN,
  ACTIVATION_TRANSFER_REQUIRED,
} from '@/lib/devices/device-copy'

export const dynamic = 'force-dynamic'

/**
 * AUDIT IS BEST-EFFORT ON THIS ROUTE. The activation (or refusal) has already been decided; a history
 * line that cannot be written is logged, never allowed to turn a working activation into a failure.
 */
async function recordAudit(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  entry: { restaurant_id: string; action: string; entity_id: string; metadata: Record<string, unknown> },
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_logs').insert({ ...entry, entity_type: 'terminal' })
    if (error) console.error('[activate] audit event not recorded', { action: entry.action, error })
  } catch (error) {
    console.error('[activate] audit event not recorded', { action: entry.action, error })
  }
}

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
      .select('id, restaurant_id, device_id, name, activation_code_expires_at, active, activation_code, transfer_request_device_id, transfer_approved_at')
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

    /**
     * ============================================================================================
     * DOES THIS DEVICE ALREADY OWN A ROW?
     * ============================================================================================
     *
     * Asked BEFORE any write, because the alternative is what shipped: write blindly, collide with
     * `restaurant_terminals_device_id_unique`, and hand the reader a 23505 dressed as
     * "Failed to activate terminal". See lib/terminals/resolve-activation-target.ts for the
     * invariant this keeps.
     *
     * TWO `.in()` READS RATHER THAN ONE `.or()`. `.in()` is parser-free -- the #242/#254 shape --
     * and these values arrive in a request body. An `.or()` string built from them would be a
     * filter expression assembled from caller input, which is exactly the class this codebase has
     * fixed twice.
     */
    const presentedIdentity = [...new Set([deviceId, deviceSerial].filter(Boolean) as string[])]
    const holders: IdentityHolder[] = []
    if (presentedIdentity.length > 0) {
      for (const column of ['device_id', 'device_serial'] as const) {
        const { data: rows, error: holderError } = await supabase
          .from('restaurant_terminals')
          .select('id, restaurant_id')
          .in(column, presentedIdentity)
        if (holderError) {
          // A failed read must not be read as "nobody holds it" -- that lands straight back on the
          // 23505 this exists to avoid. Refuse, and let the operator retry.
          console.error('[activate] could not read device identity holders', holderError)
          return NextResponse.json(
            { error: 'Could not check this device. Try again in a moment.', code: 'DEVICE_CHECK_UNAVAILABLE' },
            { status: 503 },
          )
        }
        for (const row of rows ?? []) {
          holders.push({ id: String(row.id), restaurant_id: String(row.restaurant_id) })
        }
      }
    }

    const decision = resolveActivationTarget({
      codeRow: { id: codeTerminalId, restaurant_id: codeRestaurantId },
      holders,
    })

    const refreshToken = generateRefreshToken()
    const refreshTokenHash = await hashRefreshToken(refreshToken)
    const refreshTokenExpiresAtValue = refreshTokenExpiresAt()

    /**
     * ============================================================================================
     * REGISTERED ELSEWHERE: REFUSED -- UNLESS THIS RESTAURANT APPROVED MOVING THIS DEVICE HERE
     * ============================================================================================
     *
     * The refusal (F19) is unchanged: a valid code alone never takes a device from another venue.
     * What changed is that it is no longer a dead end. The refusal records WHICH device asked on
     * this restaurant's own code row, a manager of this restaurant approves it in Settings ->
     * Devices, and the device's next attempt with the same code is carried out by
     * transfer_terminal_device() -- which re-checks the code, its expiry and that the approval is
     * for THIS device, under row locks, and releases the old registration and its session in the
     * same transaction (supabase/migrations/20260930200000).
     *
     * Only the plain case transfers: every other holder in another restaurant. A holder in THIS
     * restaurant alongside one elsewhere stays refused, exactly as before.
     */
    let transferred = false
    if (decision.kind === 'reject_cross_restaurant') {
      const others = holders.filter((h) => h.id !== codeTerminalId)
      const onlyElsewhere = others.length > 0 && others.every((h) => h.restaurant_id !== codeRestaurantId)
      const approvedForThisDevice =
        Boolean(deviceId) &&
        Boolean(data.transfer_approved_at) &&
        String(data.transfer_request_device_id ?? '') === deviceId

      if (onlyElsewhere && approvedForThisDevice) {
        const { error: transferError } = await supabase.rpc('transfer_terminal_device', {
          p_code_terminal_id: codeTerminalId,
          p_device_id: deviceId,
          p_device_serial: deviceSerial,
          p_sn: terminalSn,
          p_refresh_token_hash: refreshTokenHash,
          p_refresh_token_expires_at: refreshTokenExpiresAtValue,
        })
        if (transferError) {
          const reason = String((transferError as { message?: unknown }).message ?? '')
          console.error('[activate] transfer refused by the database', { codeTerminalId, reason })
          if (reason.includes('TRANSFER_CODE_INVALID')) {
            return NextResponse.json({ error: 'Invalid or expired activation code' }, { status: 400 })
          }
          return NextResponse.json(
            { error: ACTIVATION_TRANSFER_REQUIRED, code: 'DEVICE_REGISTERED_ELSEWHERE', transfer: 'approval_required' },
            { status: 409 },
          )
        }
        transferred = true
        console.log('[activate] device transferred here', { codeTerminalId, codeRestaurantId, released: others.length })
      } else {
        console.warn('[activate] refused: device identity is held elsewhere', {
          codeTerminalId,
          codeRestaurantId,
          holders: holders.map((h) => h.id),
        })
        const alreadyRequested = Boolean(deviceId) && String(data.transfer_request_device_id ?? '') === deviceId
        if (deviceId && onlyElsewhere && !alreadyRequested) {
          // Record the request on THIS restaurant's code row, so its managers can see and approve it.
          // A different device asking replaces the request -- and drops any approval, which was for
          // the device that asked before.
          const { error: requestError } = await supabase
            .from('restaurant_terminals')
            .update({
              transfer_request_device_id: deviceId,
              transfer_requested_at: nowIso,
              transfer_approved_at: null,
              transfer_approved_by: null,
            })
            .eq('id', codeTerminalId)
            .eq('restaurant_id', codeRestaurantId)
            .eq('active', false)
          if (requestError) {
            console.error('[activate] could not record the transfer request', requestError)
          } else {
            await recordAudit(supabase, {
              restaurant_id: codeRestaurantId,
              action: 'terminal.transfer_requested',
              entity_id: codeTerminalId,
              metadata: { deviceId, at: nowIso },
            })
          }
        }
        return NextResponse.json(
          {
            error: alreadyRequested ? ACTIVATION_TRANSFER_REQUESTED_AGAIN : ACTIVATION_TRANSFER_REQUIRED,
            code: 'DEVICE_REGISTERED_ELSEWHERE',
            transfer: onlyElsewhere ? 'approval_required' : 'not_available',
          },
          { status: 409 },
        )
      }
    }

    /**
     * THE ROW THAT ENDS UP ACTIVE. On a rebind it is the row the device already owns, NOT the row
     * the code named -- so the till keeps its id, and with it every payment, printer config and
     * audit row ever attributed to it. The code's own row is retired below. On a transfer it is the
     * code's row, already bound and activated by transfer_terminal_device().
     */
    const rebinding = decision.kind === 'rebind_existing'
    const terminalId = rebinding ? decision.terminalId : codeTerminalId
    const restaurantId = codeRestaurantId

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

    // A transfer has already bound and activated the code's row inside transfer_terminal_device();
    // writing it again here would only race that transaction. Read what it wrote instead.
    const { data: updateData, error: updateError } = transferred
      ? await supabase
          .from('restaurant_terminals')
          .select('id, restaurant_id, name, device_serial, device_id, sn')
          .eq('id', terminalId)
          .eq('restaurant_id', restaurantId)
          .single()
      : await supabase
          .from('restaurant_terminals')
          .update(updates)
          .eq('id', terminalId)
          .eq('restaurant_id', restaurantId)
          .select('id, restaurant_id, name, device_serial, device_id, sn')
          .single()

    if (updateError || !updateData?.id) {
      /**
       * NOT RETHROWN AS-IS. A PostgREST error is a PLAIN OBJECT, so the outer catch's
       * `error instanceof Error` was false and EVERY failed update -- whatever the cause --
       * collapsed to 500 "Failed to activate terminal". That message is true of every failure and
       * actionable for none of them, and the real 23505 lived only in a log with no retention.
       *
       * A duplicate HERE means the identity was claimed between the read above and this write.
       * That is answerable: reissue on the terminal that holds it.
       */
      const pgCode = (updateError as { code?: unknown } | null)?.code
      if (pgCode === '23505') {
        console.error('[activate] identity claimed between check and write', {
          terminalId,
          constraint: (updateError as { constraint?: unknown } | null)?.constraint,
        })
        return NextResponse.json(
          { error: ACTIVATION_REFUSALS.identity_taken, code: 'DEVICE_IDENTITY_TAKEN' },
          { status: 409 },
        )
      }
      console.error('[activate] terminal update failed', updateError)
      return NextResponse.json(
        {
          error: 'Could not activate this terminal. Try again in a moment.',
          code: 'ACTIVATION_WRITE_FAILED',
        },
        { status: 503 },
      )
    }

    /**
     * RETIRE THE ROW THE CODE NAMED, once the device is bound to the row it owns. Left pending it
     * would keep a live activation code against a till that does not exist, and appear in the admin
     * list as a screen nobody can pair. Best-effort: the activation has already succeeded, and
     * failing it now would be worse than a stale pending row.
     */
    if (rebinding) {
      const { error: retireError } = await supabase
        .from('restaurant_terminals')
        .update({
          status: 'revoked',
          active: false,
          activation_code: null,
          activation_code_expires_at: null,
        })
        .eq('id', decision.supersededTerminalId)
        .eq('restaurant_id', restaurantId)
      if (retireError) {
        console.error('[activate] could not retire the superseded pending row', {
          supersededTerminalId: decision.supersededTerminalId,
          error: retireError,
        })
      }
    }

    // The device's history in Settings -> Devices starts here. Best-effort: the activation has
    // succeeded, and a missing history line must not undo it. A transfer recorded its own events.
    if (!transferred) {
      await recordAudit(supabase, {
        restaurant_id: restaurantId,
        action: 'terminal.activated',
        entity_id: terminalId,
        metadata: { rebind: rebinding, codeTerminalId, deviceId: deviceId ?? null, at: nowIso },
      })
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
