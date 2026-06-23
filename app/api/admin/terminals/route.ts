import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getRestaurantIdForUser,
  getUserFromRequest,
  assertRestaurantOwner,
} from '@/lib/supabase/admin-restaurant-auth'
import {
  generateTerminalActivationCode,
  pendingTerminalDeviceId,
} from '@/lib/terminals/activation-code'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'

export const dynamic = 'force-dynamic'

function mapTerminalRow(row: Record<string, unknown>) {
  const activationCode = row.activation_code ? String(row.activation_code) : null
  const expiresAt = row.activation_code_expires_at
    ? String(row.activation_code_expires_at)
    : null
  const hasPendingCode =
    Boolean(activationCode) &&
    (!expiresAt || new Date(expiresAt).getTime() > Date.now())

  return {
    id: String(row.id),
    label: String(row.name || row.label || 'Terminal'),
    sn: row.sn ? String(row.sn) : null,
    device_id: row.device_id ? String(row.device_id) : null,
    is_active: Boolean(row.active ?? row.is_active),
    activated_at: row.activated_at ? String(row.activated_at) : null,
    last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
    has_pending_code: hasPendingCode,
    model: row.model ? String(row.model) : null,
  }
}

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantOwner(supabase, user.id, restaurantId)

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })

    if (error) throw error

    const terminals = (data || []).map((row) => mapTerminalRow(row as Record<string, unknown>))

    return NextResponse.json({ terminals })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load terminals'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('owner')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const label = String(body?.label || '').trim()
    const serialNumber = String(body?.serialNumber || '').trim()
    const deviceModel = String(body?.deviceModel || '').trim()

    if (!label) {
      return NextResponse.json({ error: 'Terminal label is required' }, { status: 400 })
    }
    if (!serialNumber) {
      return NextResponse.json({ error: 'Serial number is required' }, { status: 400 })
    }
    if (!deviceModel) {
      return NextResponse.json({ error: 'Device model is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantOwner(supabase, user.id, restaurantId)

    const code = generateTerminalActivationCode()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .insert({
        restaurant_id: restaurantId,
        name: label,
        terminal_name: label,
        sn: serialNumber,
        device_serial: serialNumber,
        device_id: pendingTerminalDeviceId(),
        model: deviceModel,
        activation_code: code,
        activation_code_expires_at: expiresAt,
        expires_at: expiresAt,
        active: false,
        status: 'active',
      })
      .select('*')
      .single()

    if (error) throw error

    await markSetupStepComplete(supabase, restaurantId, 'terminal_connected')

    return NextResponse.json({
      success: true,
      terminal: mapTerminalRow(data as Record<string, unknown>),
      code: String((data as Record<string, unknown>)?.activation_code || code),
      expiresAt: String(
        (data as Record<string, unknown>)?.activation_code_expires_at || expiresAt
      ),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to add terminal'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('owner')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
