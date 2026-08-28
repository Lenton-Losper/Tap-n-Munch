/**
 * POST /api/terminal/tabs/{tabId}/lines/{lineId}/allocate -- item-level bill splitting, the
 * WRITE side. docs/design-item-level-bill-splitting.md point 4: "Splitting has to happen BEFORE
 * settlement... a waiter taps a line, assigns it to a member, and the allocation write happens
 * then, not at settle time."
 *
 * Gated on station_screens_enabled, the same flag app/api/terminal/tabs/[tabId]/amend/route.ts
 * gates on and for the identical reason: order_lines (and therefore a line to allocate against)
 * only exists for a restaurant with that flag on.
 *
 * ONE CALL SPLITS THE WHOLE LINE. shares: [{ allocated_to, quantity_allocated }, ...] must cover
 * every unit of the line at once -- there is no "allocate half now, the rest later" in this
 * version, so a line is never left in a state where some of its money is allocated and the rest
 * silently is not (which the settle-by-allocation route would otherwise have no way to detect).
 * Re-allocating a line that already has live allocations voids the old ones first (append-only:
 * the old rows are marked voided_at, never edited) and replaces them in the same request.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { requireFeature } from '@/lib/features/get-restaurant-features'
import { readLineTotalCents, buildAllocationsForLine } from '@/lib/orders/order-line-allocations'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

type RawShare = { allocated_to?: unknown; quantity_allocated?: unknown }

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tabId: string; lineId: string }> },
) {
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

    const { tabId, lineId } = await params
    if (!tabId || !isUuid(tabId)) {
      return NextResponse.json({ error: 'tabId must be a valid UUID' }, { status: 400 })
    }
    if (!lineId || !isUuid(lineId)) {
      return NextResponse.json({ error: 'lineId must be a valid UUID' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as { shares?: unknown }
    const rawShares = Array.isArray(body.shares) ? (body.shares as RawShare[]) : []
    if (rawShares.length === 0) {
      return NextResponse.json({ error: 'shares must be a non-empty array', code: 'NO_SHARES' }, { status: 400 })
    }

    const shares: Array<{ allocated_to: string; quantity_allocated: number }> = []
    for (const raw of rawShares) {
      const allocatedTo = String(raw.allocated_to ?? '').trim()
      const quantity = Number(raw.quantity_allocated)
      if (!allocatedTo) {
        return NextResponse.json(
          { error: 'Every share needs a non-empty allocated_to', code: 'INVALID_ALLOCATED_TO' },
          { status: 400 },
        )
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return NextResponse.json(
          {
            error: `quantity_allocated for "${allocatedTo}" must be a number > 0`,
            code: 'INVALID_QUANTITY_ALLOCATED',
          },
          { status: 400 },
        )
      }
      shares.push({ allocated_to: allocatedTo, quantity_allocated: quantity })
    }

    const lineInfo = await readLineTotalCents(supabase, {
      orderLineId: lineId,
      restaurantId: terminal.restaurantId,
    })
    if (!lineInfo) {
      return NextResponse.json(
        { error: 'Line not found, or its order has no readable price for it', code: 'LINE_NOT_FOUND' },
        { status: 404 },
      )
    }

    // Bind to this tab -- never trust a cross-tab line id.
    if (lineInfo.tabId && lineInfo.tabId !== tabId) {
      return NextResponse.json(
        { error: 'line does not belong to this tab', code: 'LINE_TAB_MISMATCH' },
        { status: 400 },
      )
    }

    let builtAllocations
    try {
      builtAllocations = buildAllocationsForLine({
        restaurantId: terminal.restaurantId,
        orderId: lineInfo.orderId,
        orderLineId: lineId,
        tabId: lineInfo.tabId,
        lineTotalCents: lineInfo.totalCents,
        shares,
        actorKind: 'terminal',
        actorUserId: null,
      })
    } catch (splitErr: unknown) {
      // The arithmetic refused rather than silently producing shares that misreport their own
      // sum -- see lib/billing/split-cents.ts. Surfaced as a 400, not a 500: the input was bad,
      // the server did not fail.
      const message = splitErr instanceof Error ? splitErr.message : 'Could not split this line'
      return NextResponse.json({ error: message, code: 'SPLIT_FAILED' }, { status: 400 })
    }

    // Void any live allocations already on this line before inserting the new set -- append-
    // only replace, never edit. A line already fully settled cannot be re-split: doing so would
    // strand a paid allocation's money against a share nobody agreed it belongs to.
    const { data: existing, error: existingError } = await supabase
      .from('order_line_allocations')
      .select('id, settled_at')
      .eq('order_line_id', lineId)
      .eq('restaurant_id', terminal.restaurantId)
      .is('voided_at', null)

    if (existingError) {
      return NextResponse.json({ error: 'Failed to read existing allocations' }, { status: 500 })
    }

    const existingRows = (existing ?? []) as Array<{ id: string; settled_at: string | null }>
    const alreadySettled = existingRows.filter((r) => r.settled_at != null)
    if (alreadySettled.length > 0) {
      return NextResponse.json(
        {
          error: 'This line has already been settled in part -- it cannot be re-split.',
          code: 'ALREADY_SETTLED',
          allocation_ids: alreadySettled.map((r) => r.id),
        },
        { status: 409 },
      )
    }

    if (existingRows.length > 0) {
      const { error: voidError } = await supabase
        .from('order_line_allocations')
        .update({ voided_at: new Date().toISOString(), void_reason: 'replaced_by_reallocation' })
        .in(
          'id',
          existingRows.map((r) => r.id),
        )
        .is('voided_at', null)
        .is('settled_at', null)
      if (voidError) {
        return NextResponse.json({ error: 'Failed to void previous allocations' }, { status: 500 })
      }
    }

    const { data: inserted, error: insertError } = await supabase
      .from('order_line_allocations')
      .insert(builtAllocations)
      .select('id, allocated_to, quantity_allocated, amount_cents')

    if (insertError) {
      console.error('[terminal/tabs/lines/allocate] insert failed', insertError)
      return NextResponse.json({ error: 'Failed to write allocations' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      order_id: lineInfo.orderId,
      line_id: lineId,
      line_total_cents: lineInfo.totalCents,
      allocations: inserted,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[terminal/tabs/lines/allocate POST]', message)
    return NextResponse.json({ error: 'Failed to allocate this line' }, { status: 500 })
  }
}
