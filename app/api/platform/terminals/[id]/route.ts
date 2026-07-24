import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const ONLINE_WINDOW_MS = 15 * 60 * 1000

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const { id } = await params
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select(
        'id, restaurant_id, sn, device_serial, terminal_name, name, app_version, last_seen_at, status, active, model, restaurants(name)',
      )
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return NextResponse.json({ error: 'Terminal not found.' }, { status: 404 })
    }

    const lastSeen = data.last_seen_at ? new Date(data.last_seen_at).getTime() : Number.NaN
    const online =
      Number.isFinite(lastSeen) && lastSeen >= Date.now() - ONLINE_WINDOW_MS

    return NextResponse.json({
      terminal: { ...data, online },
      remoteActions: {
        restart: false,
        pushApk: false,
        sync: false,
      },
      note: 'Remote terminal actions are deferred.',
    })
  } catch (error) {
    console.error('[platform/terminals/[id]] GET', error)
    return NextResponse.json({ error: 'Failed to load terminal.' }, { status: 500 })
  }
}
