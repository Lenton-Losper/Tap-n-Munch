import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { buildMenuUrl } from '@/lib/base-url'

export const dynamic = 'force-dynamic'

/**
 * #265. Staff-triggered PIN recovery. Terminal-auth only -- this is a POS/terminal action,
 * not a guest one.
 *
 * WHAT THIS DOES. Mints a one-time `pin_reset_token` (crypto.randomUUID -- #241 already
 * flagged Math.random as weak for a comparable single-use code) and a short expiry, and
 * returns a recovery URL for staff to render as a QR code on their OWN screen. It does NOT
 * touch tab_pin, and does NOT touch session_version (a PIN reset is for one forgetful
 * customer; it must not invalidate every other member's already-valid session -- that is
 * session_version's job, the staff kill-switch, #235).
 *
 * WHY STAFF NEVER SEES THE PIN. The new PIN is minted later, when the token is redeemed --
 * see POST /api/tabs/[tabId]/join's resetToken branch -- and is returned ONLY in that
 * response, to whichever device presented the token. Staff's own screen only ever holds the
 * recovery URL/QR, never a PIN in any form. #265's ruling (Q1:A) treats this as a hard
 * requirement, not an accident of what happens to be true today.
 *
 * WHY A TOKEN AND NOT JUST "next scan of the table QR wins". A token that only the intended
 * customer's device receives (via a QR staff displays specifically for them) is asked-for and
 * scoped to one redemption; "first scan of the ordinary table QR after staff taps a flag"
 * would hand the reset to whoever happens to scan next, not necessarily the customer staff are
 * standing in front of.
 */
const PIN_RESET_TOKEN_TTL_MS = 15 * 60 * 1000

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tabId } = await params

    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .select('id, restaurant_id, table_number, status')
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (tabError) {
      console.error('[TABS] reset-pin: load failed', tabError)
      return NextResponse.json({ error: 'Failed to load tab' }, { status: 500 })
    }
    if (!tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }
    if (String(tab.status || '') !== 'open') {
      return NextResponse.json({ error: 'Tab is not open' }, { status: 400 })
    }

    const token = randomUUID()
    const expiresAt = new Date(Date.now() + PIN_RESET_TOKEN_TTL_MS).toISOString()

    const { error: updateError } = await supabase
      .from('tabs')
      .update({ pin_reset_token: token, pin_reset_token_expires_at: expiresAt })
      .eq('id', tabId)
      .eq('restaurant_id', terminal.restaurantId)

    if (updateError) {
      console.error('[TABS] reset-pin: update failed', updateError)
      return NextResponse.json({ error: 'Failed to start PIN reset' }, { status: 500 })
    }

    await supabase.from('audit_logs').insert({
      restaurant_id: terminal.restaurantId,
      action: 'tab.pin_reset_requested',
      entity_type: 'tab',
      entity_id: tabId,
      metadata: {
        terminalId: terminal.terminalId,
        expiresAt,
        // The token itself is deliberately NOT logged -- an audit row is read by more people
        // than should ever be able to redeem a live reset.
      },
    })

    const recoveryUrl = tab.table_number
      ? `${buildMenuUrl(terminal.restaurantId, tab.table_number)}&pinReset=${encodeURIComponent(token)}`
      : null

    return NextResponse.json({
      ok: true,
      recoveryUrl,
      expiresAt,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Failed to start PIN reset'
    console.error('[TABS] reset-pin', message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
