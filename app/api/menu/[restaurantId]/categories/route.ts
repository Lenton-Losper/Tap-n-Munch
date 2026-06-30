import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ restaurantId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(request)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { restaurantId } = await params

    // Restaurant scoping: terminal can only see its own restaurant's menu
    if (terminal.restaurantId !== restaurantId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from('menu_categories')
      .select('id, name, display_order, active')
      .eq('restaurant_id', restaurantId)
      .order('display_order')

    if (error) throw error

    const categories = (data ?? [])
      .filter((c) => c.active)
      .map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: c.display_order,
        is_active: c.active,
      }))

    return NextResponse.json({ categories })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('[MENU/CATEGORIES]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
