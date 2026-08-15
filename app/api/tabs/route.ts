import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { issueTokenForOpenTab } from '@/lib/session-token'
import { generateTabPin } from '@/lib/tabs/generate-tab-pin'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  console.log('[TABS] POST /api/tabs — create tab request received')

  try {
    const body = await req.json()
    const restaurantIdRaw = body.restaurantId ?? body.restaurant_id
    const tableNumberRaw = body.tableNumber ?? body.table_number
    const sessionId = String(body.sessionId ?? body.session_id ?? '').trim()
    const displayName = String(body.displayName ?? body.display_name ?? 'Person 1').trim() || 'Person 1'
    const customerName = String(body.customerName ?? body.customer_name ?? '').trim() || null
    /**
     * The tab this customer already held elsewhere, if any (#211 follow-up). Client-supplied and
     * therefore NOT trusted — validated below against a real, still-unpaid tab in the SAME
     * restaurant before it is stored. FLAG, not block: a bad value becomes null and the tab is
     * created regardless. Nothing about ordering depends on it.
     */
    const claimedLinkedTabId = String(
      body.linkedUnpaidTabId ?? body.linked_unpaid_tab_id ?? '',
    ).trim()

    const restaurantId = String(restaurantIdRaw || '').trim()
    const tableNumber = Number(tableNumberRaw)

    console.log('[TABS] parsed body', { restaurantId, tableNumber, hasSessionId: Boolean(sessionId) })

    if (!restaurantId) {
      console.log('[TABS] rejected — missing restaurantId')
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      console.log('[TABS] rejected — invalid tableNumber', tableNumberRaw)
      return NextResponse.json({ error: 'Invalid table number' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()

    console.log('[TABS] resolving restaurant UUID', restaurantId)
    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    console.log('[TABS] restaurant UUID resolved', restaurantUuid)

    console.log('[TABS] looking up restaurant_tables row', { restaurantUuid, tableNumber })
    const { data: tableRow, error: tableError } = await supabase
      .from('restaurant_tables')
      .select('id, table_number, current_session_version, active, is_view_only')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', tableNumber)
      .eq('active', true)
      .maybeSingle()

    if (tableError) {
      console.error('[TABS] restaurant_tables lookup error', tableError)
      return NextResponse.json({ error: tableError.message }, { status: 500 })
    }
    if (!tableRow?.id) {
      console.log('[TABS] no table found for restaurant/table_number')
      return NextResponse.json(
        { error: `Table ${tableNumber} is not set up for this restaurant. Ask staff to add it in FlashTap settings.` },
        { status: 404 }
      )
    }
    if (tableRow.is_view_only) {
      console.log('[TABS] rejected — view-only ordering point', { tableNumber })
      return NextResponse.json(
        { error: 'This is a view-only menu — ordering is not available here.' },
        { status: 403 }
      )
    }

    console.log('[TABS] table UUID found', tableRow.id)

    const { data: settingsRow, error: settingsError } = await supabase
      .from('restaurant_settings')
      .select('tab_pin_required')
      .eq('restaurant_id', restaurantUuid)
      .maybeSingle()

    if (settingsError) {
      console.error('[TABS] restaurant_settings lookup error', settingsError)
    }

    const pinRequired = settingsRow?.tab_pin_required !== false
    const tabPin = pinRequired ? generateTabPin() : null

    const members = sessionId
      ? [
          {
            session_id: sessionId,
            joined_at: new Date().toISOString(),
            display_name: displayName,
          },
        ]
      : []

    /**
     * Validated, not trusted. A client could name any uuid; storing it unchecked would put an
     * arbitrary pointer on a staff-facing flag. Requirements: it exists, it belongs to THIS
     * restaurant, it is still unpaid, and it is not this same table (which would be a rejoin,
     * not a second tab). Anything else stores null and the flag simply does not appear.
     */
    let linkedUnpaidTabId: string | null = null
    if (claimedLinkedTabId) {
      const { data: linkedTab } = await supabase
        .from('tabs')
        .select('id, status, table_number')
        .eq('id', claimedLinkedTabId)
        .eq('restaurant_id', restaurantUuid)
        .maybeSingle()
      const stillUnpaid =
        linkedTab && ['open', 'ready_to_pay'].includes(String(linkedTab.status || ''))
      if (stillUnpaid && Number(linkedTab.table_number) !== Number(tableNumber)) {
        linkedUnpaidTabId = String(linkedTab.id)
      }
    }

    const insertPayload = {
      restaurant_id: restaurantUuid,
      table_id: tableRow.id,
      table_number: tableNumber,
      status: 'open',
      members,
      total: 0,
      tab_pin: tabPin,
      pin_required: pinRequired,
      customer_name: customerName,
      linked_unpaid_tab_id: linkedUnpaidTabId,
    }

    console.log('[TABS] inserting tab row', {
      restaurant_id: insertPayload.restaurant_id,
      table_id: insertPayload.table_id,
      table_number: insertPayload.table_number,
      memberCount: members.length,
    })

    const { data: newTab, error: insertError } = await supabase
      .from('tabs')
      .insert(insertPayload)
      .select('id, restaurant_id, table_id, table_number, status, customer_name')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        // Race condition — another tab was just created for this table
        // Fetch the existing open tab and return it.
        //
        // `.is('settled_at', null)` is defence in depth. A tab that has been closed out must
        // never be handed to a walk-up scan: doing so gives the new party the previous
        // customer's name, itemised order and receipt. The settle route no longer resurrects
        // a settled tab, so this should be unreachable today — but this branch is the point
        // where such a tab would leak, and it is one line to make that impossible regardless
        // of which writer produced the state.
        const { data: existingTab, error: fetchError } = await supabase
          .from('tabs')
          .select('id, restaurant_id, table_id, table_number, status, members, total, tab_pin, pin_required')
          .eq('restaurant_id', restaurantUuid)
          .eq('table_number', tableNumber)
          .eq('status', 'open')
          .is('settled_at', null)
          .maybeSingle()

        if (fetchError || !existingTab) {
          // Distinguish "nothing joinable" from "a closed-out row is blocking this table".
          //
          // The second case is a dead end for the customer: the insert keeps hitting 23505
          // because status='open' re-arms the unique index, the guarded fetch above
          // correctly refuses the row, and every subsequent scan gets this same 409 while
          // restaurant_tables.status stays 'available' so staff see nothing wrong. Migration
          // 20260730120000 clears existing rows of that shape and the settle guard prevents
          // new ones, but if one ever appears again this must be loud rather than silent.
          const { data: blockingTab } = await supabase
            .from('tabs')
            .select('id, settled_at, settled_type')
            .eq('restaurant_id', restaurantUuid)
            .eq('table_number', tableNumber)
            .eq('status', 'open')
            .not('settled_at', 'is', null)
            .maybeSingle()

          if (blockingTab) {
            console.error(
              '[TABS] table blocked by a closed-out tab still marked open — customers cannot start a tab here',
              {
                restaurantId: restaurantUuid,
                tableNumber,
                tabId: blockingTab.id,
                settledAt: blockingTab.settled_at,
                settledType: blockingTab.settled_type,
              },
            )
            return NextResponse.json(
              {
                error: 'This table needs attention from staff before a new tab can be started',
                code: 'TABLE_BLOCKED_BY_CLOSED_TAB',
              },
              { status: 409 },
            )
          }

          return NextResponse.json({ error: 'Table already has an open tab' }, { status: 409 })
        }

        /**
         * THE PIN GATE ON THE RECOVERY BRANCH (QRA-02/QRA-03, #128/#218).
         *
         * This branch used to issue a session token here, unconditionally. A tab session token
         * is the only real credential in the QR system: it authorises adding orders to the tab
         * (POST /api/orders), reading every order on it — including each one's raw session_id,
         * which is itself the whole authorisation in ownsOrder — and moving the tab to
         * ready_to_pay, which freezes ordering and joining for everyone at the table.
         *
         * Reaching this branch needs only `restaurantId` and `tableNumber`. Both are public: the
         * restaurant uuid is in every menu URL, and the table number is printed on the table. So
         * an unauthenticated request against ANY occupied table was issued a working credential,
         * and could put items on a stranger's bill.
         *
         * #128 describes this as a race ("two people tap Create Tab simultaneously") and #218 as
         * needing a tab older than the landing's 12-hour window. Neither condition is required —
         * those govern which button the LANDING renders, not what the endpoint does. The unique
         * index fires on any tab that is already open. Reproduced against staging: 200, with a
         * token, on a tab opened seconds earlier, with no PIN and with a WRONG PIN alike — the
         * field was never read.
         *
         * RULED by the human 2026-08-15: if the tab has a PIN, require it; if it does not, refuse
         * rather than mint. So:
         *
         *   - tab HAS a pin  -> the caller must present it. This is a join, and it is now gated
         *     exactly as POST /api/tabs/join is. The genuine race (two people creating at once)
         *     lands here too, and the loser is correctly told to join rather than being dropped
         *     onto someone else's tab silently — which is #128's own recommended fix.
         *   - tab has NO pin -> refuse. That is #236's territory (pin_required true with tab_pin
         *     NULL disables the check on one of the two join routes) and it must not be resolved
         *     by minting a credential here. The client's path is POST /api/tabs/[tabId]/join,
         *     which handles the no-PIN case on its own terms.
         *
         * The response carries `tabId` so a client can route straight to the PIN prompt. That is
         * not a disclosure: GET /api/tabs/active already returns the same id unauthenticated.
         */
        const suppliedPin = String(body.pin ?? body.tabPin ?? body.tab_pin ?? '').trim()
        const existingPin = String(existingTab.tab_pin ?? '').trim()

        if (!existingPin) {
          console.warn('[TABS] refusing to mint on the 23505 branch: existing tab has no PIN', {
            restaurantId: restaurantUuid,
            tableNumber,
            tabId: existingTab.id,
            pinRequired: existingTab.pin_required,
          })
          return NextResponse.json(
            {
              error: 'This table already has an open tab. Ask staff to add you to it.',
              code: 'TAB_ALREADY_OPEN',
              tabId: existingTab.id,
            },
            { status: 409 },
          )
        }

        if (!suppliedPin || suppliedPin !== existingPin) {
          return NextResponse.json(
            {
              error: suppliedPin
                ? 'Incorrect PIN'
                : 'This table already has an open tab. Enter the tab PIN to join it.',
              code: 'TAB_PIN_REQUIRED',
              tabId: existingTab.id,
            },
            { status: 403 },
          )
        }

        // The PIN matched, so this IS a join and the caller belongs on the members list. Appended
        // through the RPC rather than a read-modify-write: this route already runs concurrently
        // with itself by construction (that is why it is on the 23505 path at all), and
        // add_tab_member does the append, the already-a-member check and the "Person N" fallback
        // inside one UPDATE. See 20260730210000_atomic_tab_member_append.sql. The old branch
        // added nobody, so a customer recovered this way was on the tab but absent from it.
        if (sessionId) {
          const { error: memberError } = await supabase.rpc('add_tab_member', {
            p_tab_id: existingTab.id,
            p_member: {
              session_id: sessionId,
              joined_at: new Date().toISOString(),
              display_name: displayName || '',
            },
          })
          if (memberError) {
            console.error('[TABS] add_tab_member failed on the 23505 join path', memberError)
            return NextResponse.json({ error: memberError.message }, { status: 500 })
          }
        }

        const sessionToken = await issueTokenForOpenTab(
          supabase,
          existingTab.id,
          tableRow.id,
          restaurantUuid
        )

        console.log('[TABS] 23505 recovery — PIN verified, joined existing tab', existingTab.id)

        return NextResponse.json({
          success: true,
          tabId: existingTab.id,
          restaurantId: existingTab.restaurant_id,
          tableId: existingTab.table_id,
          tableNumber: existingTab.table_number,
          sessionToken,
          joinedExisting: true,
        })
      }

      console.error('[TABS] insert failed', insertError)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    if (!newTab?.id) {
      console.error('[TABS] insert returned no row')
      return NextResponse.json({ error: 'Tab was not created' }, { status: 500 })
    }

    console.log('[TABS] tab created successfully', newTab)

    await supabase.from('restaurant_tables').update({ status: 'occupied' }).eq('id', tableRow.id)

    console.log('[TOKEN-4] calling issueTokenForOpenTab')
    const sessionToken = await issueTokenForOpenTab(
      supabase,
      newTab.id,
      tableRow.id,
      restaurantUuid
    )
    console.log('[TOKEN-4] sessionToken result', sessionToken, typeof sessionToken)

    return NextResponse.json({
      success: true,
      tabId: newTab.id,
      restaurantId: newTab.restaurant_id,
      tableId: newTab.table_id,
      tableNumber: newTab.table_number,
      customer_name: newTab.customer_name ?? null,
      sessionToken,
      ...(tabPin ? { tabPin } : {}),
    })
  } catch (err) {
    console.error('[TABS] unexpected error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
