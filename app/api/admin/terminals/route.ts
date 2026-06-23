import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getRestaurantIdForUser,
  getUserFromRequest,
  assertRestaurantOwner,
} from '@/lib/supabase/admin-restaurant-auth'
import { generateTerminalActivationCode } from '@/lib/terminals/activation-code'
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
