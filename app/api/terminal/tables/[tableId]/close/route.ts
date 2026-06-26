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
