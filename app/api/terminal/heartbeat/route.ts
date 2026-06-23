import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = await req.json().catch(() => ({}))
    const appVersion = body?.appVersion ? String(body.appVersion).trim() : null
    const now = new Date().toISOString()

    const updates: Record<string, string> = {
      last_seen_at: now,
    }

    if (appVersion) {
      updates.app_version = appVersion
    }

    const { error } = await supabase
      .from('restaurant_terminals')
      .update(updates)
      .eq('id', terminal.terminalId)
      .eq('restaurant_id', terminal.restaurantId)

    if (error) {
      return NextResponse.json({ error: 'Failed to update heartbeat' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, serverTime: now })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
