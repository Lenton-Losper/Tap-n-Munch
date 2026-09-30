/**
 * GET  /api/admin/devices  -- every payment terminal and kitchen/bar screen of the caller's
 *                             restaurant, in the shape the Devices console renders.
 * POST /api/admin/devices  -- issue an activation code for a new device: { kind, name? }.
 *
 * WHAT GET NEVER RETURNS: an activation code (only its last four characters), a refresh-token hash,
 * or a row UUID as the thing a person is meant to recognise a device by. The full code is shown
 * exactly once, by POST -- the rule lib/stations/pairing-copy.ts records for paired screens,
 * applied to payment terminals too.
 */
import { NextResponse } from 'next/server'
import { generateTerminalActivationCode } from '@/lib/terminals/activation-code'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'
import { resolveDeviceCaller, forbiddenForKind } from '@/lib/devices/device-route-auth'
import { DEVICE_ROW_COLUMNS } from '@/lib/devices/device-lifecycle'
import { toDeviceView } from '@/lib/devices/device-view'
import type { DeviceKind, DeviceRow } from '@/lib/devices/device-state'

export const dynamic = 'force-dynamic'

const CODE_TTL_MS = 60 * 60 * 1000

export async function GET(request: Request) {
  const caller = await resolveDeviceCaller(request)
  if (caller instanceof NextResponse) return caller
  try {
    const { data, error } = await caller.supabase
      .from('restaurant_terminals')
      .select(DEVICE_ROW_COLUMNS)
      .eq('restaurant_id', caller.restaurantId)
      .order('created_at', { ascending: false })
    if (error) throw error

    const now = Date.now()
    const rows = ((data ?? []) as unknown as DeviceRow[]).filter((row) => {
      const kind: DeviceKind = row.station_kind === 'kitchen' ? 'kitchen' : row.station_kind === 'bar' ? 'bar' : 'payment'
      return caller.canManage[kind]
    })

    // Recent card activity per payment terminal: the newest sale event in the last 30 days.
    // Display only -- one read for the whole list, and a failure omits the figure.
    const paymentIds = rows.filter((r) => !r.station_kind).map((r) => String(r.id))
    const lastSale = new Map<string, string>()
    if (paymentIds.length > 0) {
      const since = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: sales, error: salesError } = await caller.supabase
        .from('payment_events')
        .select('terminal_id, created_at')
        .eq('restaurant_id', caller.restaurantId)
        .eq('event_type', 'sale')
        .in('terminal_id', paymentIds)
        .gte('created_at', since)
      if (salesError) {
        console.error('[admin/devices] recent sales unreadable; listing without them', salesError)
      } else {
        for (const s of (sales ?? []) as Array<{ terminal_id: string; created_at: string }>) {
          const prev = lastSale.get(String(s.terminal_id))
          if (!prev || prev < s.created_at) lastSale.set(String(s.terminal_id), s.created_at)
        }
      }
    }

    const { data: restaurant } = await caller.supabase
      .from('restaurants')
      .select('name')
      .eq('id', caller.restaurantId)
      .maybeSingle()

    const devices = rows.map((row) => toDeviceView(row, now, lastSale.get(String(row.id)) ?? null))
    return NextResponse.json({
      devices,
      canManage: caller.canManage,
      restaurantName: (restaurant as { name?: string } | null)?.name ?? null,
    })
  } catch (error) {
    console.error('[admin/devices] list failed', error)
    return NextResponse.json({ error: 'Could not load your devices. Try again.' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const caller = await resolveDeviceCaller(request)
  if (caller instanceof NextResponse) return caller
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; name?: unknown }
  const kind = String(body.kind ?? 'payment') as DeviceKind
  if (!['payment', 'kitchen', 'bar'].includes(kind)) {
    return NextResponse.json({ error: 'Choose a payment terminal, kitchen screen or bar screen.' }, { status: 400 })
  }
  if (!caller.canManage[kind]) return forbiddenForKind(kind)

  const defaultName = kind === 'payment' ? 'New Terminal' : kind === 'kitchen' ? 'Kitchen Screen' : 'Bar Screen'
  const name = String(body.name ?? '').trim().slice(0, 60) || defaultName
  const activationCode = generateTerminalActivationCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    const { data: row, error } = await caller.supabase
      .from('restaurant_terminals')
      .insert({
        restaurant_id: caller.restaurantId,
        device_serial: null,
        activation_code: activationCode,
        activation_code_expires_at: expiresAt,
        status: 'pending',
        active: false,
        terminal_name: name,
        station_kind: kind === 'payment' ? null : kind,
      })
      .select('id')
      .single()
    if (error) throw error

    await caller.supabase.from('audit_logs').insert({
      restaurant_id: caller.restaurantId,
      action: 'terminal.activation_code_issued',
      entity_type: 'terminal',
      entity_id: String(row.id),
      metadata: { by: caller.userId, kind, name, expiresAt },
    })
    if (kind === 'payment') {
      await markSetupStepComplete(caller.supabase, caller.restaurantId, 'terminal_connected')
    }

    return NextResponse.json({ id: row.id, kind, name, activationCode, expiresAt })
  } catch (error) {
    console.error('[admin/devices] could not issue a code', error)
    return NextResponse.json({ error: 'Could not create an activation code. Try again.' }, { status: 500 })
  }
}
