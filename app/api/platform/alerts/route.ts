import { NextResponse } from 'next/server'
import {
  requirePlatformRole,
  resolvePlatformAdmin,
  writePlatformAudit,
} from '@/lib/permissions/assert-platform-admin'
import { computePlatformAlerts } from '@/lib/platform/dashboard'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const url = new URL(request.url)
    const activeOnly = url.searchParams.get('active') === '1'
    let alerts = await computePlatformAlerts()
    if (activeOnly) {
      alerts = alerts.filter((a) => a.ackStatus !== 'resolved')
    }
    return NextResponse.json({ alerts })
  } catch (err) {
    console.error('[platform/alerts] GET', err)
    return NextResponse.json({ error: 'Failed to load alerts' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  // support + super_admin can acknowledge
  const admin = await requirePlatformRole(request, ['support', 'super_admin'])
  if (admin instanceof NextResponse) return admin

  try {
    const body = (await request.json()) as {
      alertKey?: string
      status?: 'acknowledged' | 'resolved' | 'open'
      note?: string
    }
    const alertKey = String(body.alertKey || '').trim()
    const status = body.status || 'acknowledged'
    if (!alertKey) {
      return NextResponse.json({ error: 'alertKey required' }, { status: 400 })
    }
    if (!['acknowledged', 'resolved', 'open'].includes(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('platform_alert_acks')
      .upsert(
        {
          alert_key: alertKey,
          status,
          actor_id: admin.userId,
          actor_email: admin.email,
          note: body.note?.trim() || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'alert_key' },
      )
      .select('*')
      .single()

    if (error) throw error

    await writePlatformAudit({
      actorId: admin.userId,
      actorEmail: admin.email,
      action: 'alert_ack_updated',
      targetType: 'platform_alert',
      targetId: null,
      payload: { alertKey, status, note: body.note ?? null },
      request,
    })

    return NextResponse.json({ ack: data })
  } catch (err) {
    console.error('[platform/alerts] PATCH', err)
    return NextResponse.json({ error: 'Failed to update alert' }, { status: 500 })
  }
}
