import { guardTableClose } from '@/lib/tabs/pending-order-requests'
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { closeTableSession } from '@/lib/session-manager'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { tableId } = await params

    /**
     * #120 — THE PREFLIGHT. This is the point of no return, so it is the one that must fail closed.
     *
     * `close_table_session` SETTLES every tab at the table and bumps `current_session_version`,
     * which evicts every customer session. A round still waiting for staff review is not in
     * `orders`, so nothing this route previously consulted could see it — and after the close it
     * re-inflates a tab that has been paid and closed the moment somebody presses Accept.
     *
     * REFUSING IS THE WHOLE FIX. This route does not accept, decline, or reassign anything; the
     * resolution is a human pressing Accept or Decline on the dashboard. What it stops is the
     * table being closed over the top of a decision nobody has made yet.
     *
     * The tabs read is scoped by restaurant AND table, and both filters are `.eq()` — parser-free.
     * `tableId` arrives from the URL path, and a caller-controlled value inside a PostgREST `.or()`
     * expression is this project's #242 / #254 defect class.
     */
    /**
     * #120 — THE GUARD, shared with the staff dashboard's close route.
     *
     * It used to live inline here, and that is precisely why the dashboard's route went unguarded:
     * two routes doing one job, with the rule written into only one of them. It is now in
     * `lib/tabs/pending-order-requests.ts` and both call it.
     */
    const guard = await guardTableClose(supabase, {
      restaurantId: terminal.restaurantId,
      tableId,
    })
    if (guard.blocked) {
      return NextResponse.json(guard.body, { status: guard.status })
    }

    await closeTableSession({
      supabase,
      restaurantId: terminal.restaurantId,
      tableId,
      closedBy: terminal.terminalId,
      source: 'terminal',
    })

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/tables/close]', err)
    return NextResponse.json({ error: 'Failed to close table' }, { status: 500 })
  }
}
