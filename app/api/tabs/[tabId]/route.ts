import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireSessionToken } from '@/lib/session-guard'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params
  const normalizedTabId = String(tabId || '').trim()

  if (!normalizedTabId) {
    return NextResponse.json({ error: 'Missing tab id' }, { status: 400 })
  }

  const guard = await requireSessionToken(req)
  if (guard.error) return guard.error

  if (guard.tabId && guard.tabId !== normalizedTabId) {
    return NextResponse.json({ error: 'Session token does not match this tab' }, { status: 403 })
  }

  try {
    const supabase = createServerSupabaseClient()
    const { data: tab, error } = await supabase
      .from('tabs')
      .select('id, restaurant_id, table_id, table_number, status, total, members, session_version')
      .eq('id', normalizedTabId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true, tab })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
