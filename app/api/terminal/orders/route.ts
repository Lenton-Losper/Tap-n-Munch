import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:read')) {
      return NextResponse.json(
        { error: 'Missing permission: orders:read' },
        { status: 403 }
      )
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', terminal.restaurantId)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready'])
      .order('placed_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 })
    }

    return NextResponse.json({ orders: data })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
