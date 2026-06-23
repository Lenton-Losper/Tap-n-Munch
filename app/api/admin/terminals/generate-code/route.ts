import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantOwner,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import {
  generateTerminalActivationCode,
  pendingTerminalDeviceId,
} from '@/lib/terminals/activation-code'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    console.log('[generate-code] user:', user?.id)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    console.log('[generate-code] restaurantId:', restaurantId)
    await assertRestaurantOwner(supabase, user.id, restaurantId)

    const { count, error: countError } = await supabase
      .from('restaurant_terminals')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)

    if (countError) throw countError

    const code = generateTerminalActivationCode()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const terminalNumber = (count ?? 0) + 1

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .insert({
        restaurant_id: restaurantId,
        activation_code: code,
        activation_code_expires_at: expiresAt,
        expires_at: expiresAt,
        active: false,
        name: `Terminal ${terminalNumber}`,
        device_id: pendingTerminalDeviceId(),
      })
      .select('id, activation_code, activation_code_expires_at')
      .single()

    if (error) {
      console.error('[generate-code] insert error full:', JSON.stringify(error))
      throw new Error(error.message || 'Database insert failed')
    }

    await markSetupStepComplete(supabase, restaurantId, 'terminal_connected')

    return NextResponse.json({
      success: true,
      code: data?.activation_code || code,
      expiresAt: data?.activation_code_expires_at || expiresAt,
      terminalId: data?.id,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to generate activation code'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('owner') || message.includes('permission')
          ? 403
          : 500
    console.error('[terminals/generate-code] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
