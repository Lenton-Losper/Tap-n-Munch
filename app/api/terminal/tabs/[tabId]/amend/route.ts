/**
 * POST /api/terminal/tabs/{tabId}/amend -- change the quantity of a line before it's cooked.
 *
 * The whole edit-before-prep feature was blocked on this route not existing. Max verified only
 * lines and settle exist under terminal/tabs/[tabId]/ -- see the migration
 * (20260829150000_amend_order_lines_function.sql) for the atomicity design this wraps.
 *
 * ONE RPC CALL PER ATTEMPT, wrapped in the same bounded order-number retry
 * insertWithOrderNumber() already uses: amend_order_lines() does the real work (void-and-
 * replace, per line, one transaction) and either returns cleanly or raises. A raised unique-
 * index violation on order_number means the whole transaction rolled back -- nothing voided,
 * nothing inserted -- so retrying the WHOLE call with a freshly read number is safe. Any other
 * error is not retried.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { nextOrderNumber, isOrderNumberCollision } from '@/lib/orders/order-number'

export const dynamic = 'force-dynamic'

const MAX_ORDER_NUMBER_ATTEMPTS = 6

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

type CleanAmendment = { line_id: string; new_quantity: number }

export async function POST(req: Request, { params }: { params: Promise<{ tabId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

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

    const { tabId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tabId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as { amendments?: unknown }
    const rawAmendments = Array.isArray(body.amendments) ? body.amendments : []
    if (rawAmendments.length === 0) {
      return NextResponse.json({ error: 'amendments must be a non-empty array' }, { status: 400 })
    }

    const amendments: CleanAmendment[] = []
    for (const raw of rawAmendments) {
      const entry = raw as { line_id?: unknown; new_quantity?: unknown }
      const lineId = String(entry.line_id ?? '').trim()
      const quantity = Number(entry.new_quantity)

      if (!lineId || !isUuid(lineId)) {
        return NextResponse.json(
          { error: 'Every amendment needs a valid line_id', code: 'INVALID_LINE_ID' },
          { status: 400 },
        )
      }
      if (!Number.isFinite(quantity) || quantity < 0) {
        return NextResponse.json(
          {
            error: `new_quantity for line ${lineId} must be a number >= 0`,
            code: 'INVALID_QUANTITY',
            line_id: lineId,
          },
          { status: 400 },
        )
      }
      amendments.push({ line_id: lineId, new_quantity: quantity })
    }

    let lastError: { code?: string | null; message?: string | null } | null = null
    let lastData: unknown = null

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      const orderNumber = await nextOrderNumber(supabase, terminal.restaurantId)
      const { data, error } = await supabase.rpc('amend_order_lines', {
        p_restaurant_id: terminal.restaurantId,
        p_tab_id: tabId,
        p_order_number: orderNumber,
        p_actor_kind: 'terminal',
        p_actor_user_id: null,
        p_amendments: amendments,
      })

      lastData = data
      lastError = error

      if (!error) break
      if (!isOrderNumberCollision(error)) break

      console.warn(
        `[terminal/tabs/amend] order #${orderNumber} was taken at ${terminal.restaurantId} -- ` +
          `attempt ${attempt}/${MAX_ORDER_NUMBER_ATTEMPTS}, retrying the whole amendment.`,
      )
    }

    if (lastError) {
      console.error('[terminal/tabs/amend] RPC failed', lastError)
      return NextResponse.json(
        { error: 'Could not apply this amendment', code: 'AMEND_FAILED' },
        { status: 502 },
      )
    }

    const result = lastData as {
      order_id: string | null
      order_number: number | null
      applied: Array<{ line_id: string; action: 'voided' | 'replaced'; new_line_id?: string }>
      refused: Array<{ line_id: string; reason: string }>
    }

    return NextResponse.json({
      success: true,
      order_id: result.order_id,
      order_number: result.order_number,
      applied: result.applied,
      refused: result.refused,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/tabs/amend POST]', message)
    return NextResponse.json({ error: 'Failed to amend the tab' }, { status: 500 })
  }
}
