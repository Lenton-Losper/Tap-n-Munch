/**
 * ADR-005 §3 -- a waiter opens a table, creating the service session they own.
 *
 * ============================================================================================
 * WHY THIS REUSES THE PIN MACHINERY INSTEAD OF VERIFYING A PIN ITSELF
 * ============================================================================================
 *
 * The device calls POST /api/terminal/authorize first with purpose 'service_session', and passes
 * the resulting token_id here. Nothing in this file touches a PIN.
 *
 * That is deliberate. `/authorize` already carries lockout after repeated failures, membership
 * checking against restaurant_users, permission checking through authorize(), PBKDF2 verification
 * and an `authorization_events` audit row. Re-implementing any of that here would produce a second
 * PIN path with its own bugs, and the one that skipped lockout would be the one waiters used every
 * shift.
 *
 * ============================================================================================
 * PIN-TOKEN FAILURES ANSWER 403, NEVER 401
 * ============================================================================================
 *
 * `terminalFetch` in the terminal app treats 401 as "my terminal token aged out" and responds by
 * refreshing that token and retrying. An expired PIN authorization is a completely different
 * event -- the human must type their PIN again -- and answering 401 would send the device into a
 * refresh-and-retry loop that can never succeed, which is the #327-shaped defect
 * `lib/terminal-auth.ts` was rewritten to close.
 *
 * So every authorization failure here is 403 with a distinct `code` the device can branch on.
 *
 * ============================================================================================
 * RE-OPENING AN OPEN TABLE IS NOT AN ERROR
 * ============================================================================================
 *
 * A waiter tapping a table that already has a live tab wants to ADD to it -- that is step D of
 * ADR-005 §6, a second round on an existing tab. So this route is idempotent: it returns the
 * existing tab with `already_open: true` rather than refusing, and never creates a second tab for
 * one table. Refusing would leave the device with no way to reach a table it can plainly see.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
import { markTableOccupied } from '@/lib/tables/mark-table-occupied'
import { claimTableForWaiter, loadTableOwners } from '@/lib/tables/table-owners'

export const dynamic = 'force-dynamic'

const SERVICE_SESSION_PURPOSE = 'service_session'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** Every one of these is 403. See the header: 401 means "refresh the terminal token". */
const AUTHORIZATION_FAILURE_CODES: Record<string, string> = {
  not_found: 'AUTHORIZATION_NOT_FOUND',
  already_used: 'AUTHORIZATION_ALREADY_USED',
  expired: 'AUTHORIZATION_EXPIRED',
  mismatch: 'AUTHORIZATION_MISMATCH',
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    /**
     * ADR-005 is a station_screens_enabled venue's flow, not server policy yet. Riviera-only was
     * an accident of client version -- Mingle and ChowNow are protected only by an old APK never
     * calling this endpoint, not by anything server-side. Added 2026-08-28.
     */
    const { allowed } = await requireFeature(terminal.restaurantId, 'station_screens_enabled')
    if (!allowed) {
      return NextResponse.json(
        { error: 'Waiter-led service is not enabled for this restaurant', code: 'STATION_SCREENS_DISABLED' },
        { status: 403 },
      )
    }

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tableId } = await params
    if (!tableId || !isUuid(tableId)) {
      return NextResponse.json({ error: 'tableId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      user_id?: unknown
      authorization_token_id?: unknown
      customer_name?: unknown
    }
    const userId = String(body.user_id ?? '').trim()
    const tokenId = String(body.authorization_token_id ?? '').trim()
    // Optional -- a waiter can open a table without naming who it is for. Capped well above any
    // real name so a stray paste cannot blow out the floor grid's row height.
    const customerNameRaw = typeof body.customer_name === 'string' ? body.customer_name.trim() : ''
    const customerName = customerNameRaw.slice(0, 100) || null

    if (!userId || !isUuid(userId)) {
      return NextResponse.json({ error: 'user_id must be a valid UUID' }, { status: 400 })
    }
    if (!tokenId || !isUuid(tokenId)) {
      return NextResponse.json(
        { error: 'authorization_token_id must be a valid UUID' },
        { status: 400 },
      )
    }

    /**
     * The table is read and scoped BEFORE the token is consumed. The token is single-use, so
     * burning it on a request that was going to fail on a bad table id would make the waiter
     * type their PIN again for our validation error.
     */
    const { data: table, error: tableError } = await supabase
      .from('restaurant_tables')
      .select('id, restaurant_id, table_number, active')
      .eq('id', tableId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (tableError) throw tableError
    if (!table?.id) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 })
    }
    if (table.active === false) {
      return NextResponse.json({ error: 'Table is not active' }, { status: 409 })
    }

    const consumed = await consumeAuthorizationToken(supabase, {
      tokenId,
      expectedUserId: userId,
      expectedRestaurantId: terminal.restaurantId,
      expectedTerminalId: terminal.terminalId,
      expectedPurpose: SERVICE_SESSION_PURPOSE,
    })

    if (!consumed.ok) {
      return NextResponse.json(
        {
          error: 'Authorization failed',
          code: AUTHORIZATION_FAILURE_CODES[consumed.reason] ?? 'AUTHORIZATION_FAILED',
        },
        { status: 403 },
      )
    }

    // An existing live tab means "add a round", not "start again". See the header.
    const { data: existingTab, error: existingTabError } = await supabase
      .from('tabs')
      .select('id, status, total, created_at, opened_by_user_id, customer_name')
      .eq('restaurant_id', terminal.restaurantId)
      .eq('table_id', table.id)
      .in('status', ['open', 'ready_to_pay'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingTabError) throw existingTabError

    if (existingTab?.id) {
      /**
       * ADOPTION. The service session attaches to the tab that is already there and the waiter
       * becomes its owner. No second tab, no refusal.
       *
       * Refusing would strand every table that already carries a tab -- and Riviera has those
       * right now. A waiter who cannot open them cannot serve them, on the first morning, with
       * no workaround on the device.
       */
      const claim = await claimTableForWaiter(
        supabase,
        terminal.restaurantId,
        table.id,
        userId,
      )

      /**
       * FILL THE TIP ANCHOR ONLY IF IT IS EMPTY.
       *
       * A tab opened by a customer scanning a QR code has no opened_by_user_id, so nobody can be
       * credited for serving it. The waiter who adopts it is the person actually serving it, so
       * they take that slot.
       *
       * NEVER OVERWRITE AN EXISTING VALUE. That column is the tip anchor and is immutable once
       * set: overwriting it on adoption would let a second waiter tapping the table at 21:00 walk
       * off with the tip earned by whoever opened it at 18:00. The `.is('opened_by_user_id', null)`
       * filter is what makes that impossible rather than merely unlikely.
       */
      let adoptedOwnerId = existingTab.opened_by_user_id ?? null
      if (!adoptedOwnerId) {
        const { data: claimedTab, error: claimTabError } = await supabase
          .from('tabs')
          .update({ opened_by_user_id: userId })
          .eq('id', existingTab.id)
          .is('opened_by_user_id', null)
          .select('opened_by_user_id')
          .maybeSingle()

        if (claimTabError) {
          console.error('[terminal/tables/open] could not adopt the unowned tab', claimTabError)
        } else if (claimedTab?.opened_by_user_id) {
          adoptedOwnerId = String(claimedTab.opened_by_user_id)
        }
      }

      // Same fill-only-if-empty rule as opened_by_user_id, but this one is not a tip anchor --
      // just avoids a waiter's later "adopt" silently overwriting a name someone already typed.
      let adoptedCustomerName = existingTab.customer_name ?? null
      if (!adoptedCustomerName && customerName) {
        const { data: namedTab, error: nameError } = await supabase
          .from('tabs')
          .update({ customer_name: customerName })
          .eq('id', existingTab.id)
          .is('customer_name', null)
          .select('customer_name')
          .maybeSingle()

        if (nameError) {
          console.error('[terminal/tables/open] could not set customer_name on adopt', nameError)
        } else if (namedTab?.customer_name) {
          adoptedCustomerName = String(namedTab.customer_name)
        }
      }

      const owner =
        (await loadTableOwners(supabase, terminal.restaurantId, [table.id])).get(table.id) ?? null

      return NextResponse.json({
        already_open: true,
        adopted: true,
        handed_over_from: claim.handedOverFrom,
        table: { id: table.id, table_number: table.table_number },
        tab: {
          id: existingTab.id,
          status: existingTab.status,
          total: existingTab.total,
          opened_at: existingTab.created_at,
          opened_by_user_id: adoptedOwnerId,
          customer_name: adoptedCustomerName,
        },
        owner,
      })
    }

    const { data: tab, error: tabError } = await supabase
      .from('tabs')
      .insert({
        restaurant_id: terminal.restaurantId,
        table_id: table.id,
        table_number: table.table_number,
        status: 'open',
        members: [],
        total: 0,
        // ADR-005 §6: snapshotted at open, never updated. The tip anchor.
        opened_by_user_id: userId,
        customer_name: customerName,
      })
      .select('id, status, total, created_at, opened_by_user_id, customer_name')
      .single()

    if (tabError || !tab?.id) throw tabError ?? new Error('Failed to create tab')

    /**
     * The assignment. A partial unique index allows only ONE open assignment per table, so a
     * concurrent open by a second waiter loses this insert rather than creating an ambiguous
     * second owner (ADR-005 event E).
     *
     * A failure here does NOT fail the request. The tab exists and the waiter can take the order;
     * losing the assignment costs the floor grid an owner name, and refusing the request would
     * cost the customer their order. Logged loudly, same trade as markTableOccupied.
     */
    await claimTableForWaiter(supabase, terminal.restaurantId, table.id, userId)

    // #216: a table with a live tab and a non-'occupied' status is invisible on the terminal.
    await markTableOccupied(supabase, table.id, '[terminal/tables/open]')

    const owner =
      (await loadTableOwners(supabase, terminal.restaurantId, [table.id])).get(table.id) ?? null

    return NextResponse.json({
      already_open: false,
      adopted: false,
      handed_over_from: null,
      table: { id: table.id, table_number: table.table_number },
      tab: {
        id: tab.id,
        status: tab.status,
        total: tab.total,
        opened_at: tab.created_at,
        opened_by_user_id: tab.opened_by_user_id ?? null,
        customer_name: tab.customer_name ?? null,
      },
      owner,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/tables/open POST]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
