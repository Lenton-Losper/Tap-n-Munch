/**
 * GET /api/admin/devices/:deviceId/activity -- the device's lifecycle history (activation, rename,
 * deactivate, transfer, removal of a predecessor...) from audit_logs, newest first. Scoped to the
 * caller's restaurant: a transfer-out event recorded in another venue is never visible here.
 */
import { NextResponse } from 'next/server'
import { resolveDeviceCaller, forbiddenForKind } from '@/lib/devices/device-route-auth'
import { loadDevice } from '@/lib/devices/device-lifecycle'
import { deviceKind } from '@/lib/devices/device-state'
import { describeDeviceEvent } from '@/lib/devices/device-copy'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await resolveDeviceCaller(request)
  if (caller instanceof NextResponse) return caller
  try {
    const { deviceId } = await params
    const row = await loadDevice(caller.supabase, caller.restaurantId, deviceId)
    if (!row) {
      return NextResponse.json({ error: 'This device was not found in your restaurant.', code: 'DEVICE_NOT_FOUND' }, { status: 404 })
    }
    if (!caller.canManage[deviceKind(row)]) return forbiddenForKind(deviceKind(row))

    const { data, error } = await caller.supabase
      .from('audit_logs')
      .select('action, metadata, created_at')
      .eq('restaurant_id', caller.restaurantId)
      .eq('entity_type', 'terminal')
      .eq('entity_id', deviceId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error

    const events = (data ?? []).map((e: { action: string; metadata: unknown; created_at: string }) => ({
      at: e.created_at,
      action: e.action,
      description: describeDeviceEvent(e.action),
    }))
    return NextResponse.json({
      events,
      lastSeenAt: row.activated_at ? (row.last_seen_at ?? null) : null,
      appVersion: row.app_version ?? null,
    })
  } catch (error) {
    console.error('[admin/devices] activity failed', error)
    return NextResponse.json({ error: 'Could not load this device’s activity.' }, { status: 500 })
  }
}
