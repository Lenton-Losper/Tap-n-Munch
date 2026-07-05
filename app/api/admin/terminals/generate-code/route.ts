import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { generateTerminalActivationCode } from '@/lib/terminals/activation-code'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.PAYMENTS_CONFIGURE)
    if (denied) return denied

    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    const serialNumber = String(body?.serialNumber || '').trim()
    const activationCode = generateTerminalActivationCode()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    if (!serialNumber) {
      const { data: terminal, error: terminalError } = await supabase
        .from('restaurant_terminals')
        .insert({
          restaurant_id: restaurantId,
          device_serial: null,
          activation_code: activationCode,
          activation_code_expires_at: expiresAt,
          status: 'pending',
          active: false,
          terminal_name: 'New Terminal',
        })
        .select('id, activation_code, activation_code_expires_at')
        .single()

      if (terminalError) {
        console.error('[generate-code] insert error full:', JSON.stringify(terminalError))
        throw new Error(terminalError.message || 'Database insert failed')
      }

      return NextResponse.json({
        activationCode: terminal?.activation_code || activationCode,
        expiresAt: terminal?.activation_code_expires_at || expiresAt,
      })
    }

    const { count, error: countError } = await supabase
      .from('restaurant_terminals')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)

    if (countError) throw countError

    const deviceModel = String(body?.deviceModel || '').trim() || null
    const terminalNumber = (count ?? 0) + 1
    const terminalLabel =
      String(body?.terminalLabel || body?.label || '').trim() ||
      `Terminal ${terminalNumber}`

    const { data: terminal, error: terminalError } = await supabase
      .from('restaurant_terminals')
      .upsert(
        {
          restaurant_id: restaurantId,
          device_serial: serialNumber,
          model: deviceModel,
          terminal_name: terminalLabel,
          activation_code: activationCode,
          activation_code_expires_at: expiresAt,
          status: 'active',
        },
        { onConflict: 'device_serial' },
      )
      .select('id, activation_code, activation_code_expires_at')
      .single()

    if (terminalError) {
      console.error('[generate-code] insert error full:', JSON.stringify(terminalError))
      throw new Error(terminalError.message || 'Database insert failed')
    }

    await markSetupStepComplete(supabase, restaurantId, 'terminal_connected')

    return NextResponse.json({
      activationCode: terminal?.activation_code || activationCode,
      expiresAt: terminal?.activation_code_expires_at || expiresAt,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to generate activation code'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[terminals/generate-code] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
