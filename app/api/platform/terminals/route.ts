import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const ONLINE_WINDOW_MS = 15 * 60 * 1000

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false
  const lastSeen = new Date(lastSeenAt).getTime()
  return Number.isFinite(lastSeen) && lastSeen >= Date.now() - ONLINE_WINDOW_MS
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select(
        'id, restaurant_id, sn, device_serial, terminal_name, name, app_version, last_seen_at, status, active, model, restaurants(name)',
      )
      .order('last_seen_at', { ascending: false, nullsFirst: false })

    if (error) throw error

    const terminals = (data ?? []).map((terminal) => ({
      ...terminal,
      online: isOnline(terminal.last_seen_at),
    }))

    return NextResponse.json({ terminals })
  } catch (error) {
    console.error('[platform/terminals] GET', error)
    return NextResponse.json({ error: 'Failed to load terminals.' }, { status: 500 })
  }
}
