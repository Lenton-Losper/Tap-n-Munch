import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantOwner,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { generateTerminalActivationCode } from '@/lib/terminals/activation-code'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  console.log('[generate-code] NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log('[generate-code] SERVICE_ROLE_KEY prefix:', process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 40))
  try {
    const user = await getUserFromRequest(request)
    console.log('[generate-code] user:', user?.id)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    console.log('[generate-code] restaurantId:', restaurantId)
    await assertRestaurantOwner(supabase, user.id, restaurantId)

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

      console.log('[generate-code] insert result:', JSON.stringify({ data: terminal, error: terminalError }))

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
        { onConflict: 'device_serial' }
      )
      .select('id, activation_code, activation_code_expires_at')
      .single()

    console.log('[generate-code] insert result:', JSON.stringify({ data: terminal, error: terminalError }))

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
        : message.includes('owner') || message.includes('permission')
          ? 403
          : 500
    console.error('[terminals/generate-code] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
