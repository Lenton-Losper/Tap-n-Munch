import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    const record = await validateTerminalRecord(supabase, terminal)

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('name')
      .eq('id', terminal.restaurantId)
      .maybeSingle()

    if (restaurantError) {
      return NextResponse.json({ error: 'Failed to load restaurant' }, { status: 500 })
    }

    return NextResponse.json({
      terminalId: terminal.terminalId,
      restaurantId: terminal.restaurantId,
      restaurantName: String(restaurant?.name || 'Restaurant'),
      status: String(record.status || 'active'),
      permissions: terminal.permissions,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
