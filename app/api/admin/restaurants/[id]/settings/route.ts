import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const ALLOWED_SETTINGS = [
  'payment_methods',
  'kiosk_payment_methods',
  'tab_pin_required',
  'max_tab_hours',
  'allow_split_bill',
  'currency',
  'timezone',
  'tax_rate',
  'service_charge',
]

const VALID_KIOSK_METHODS = ['cash', 'card', 'other']

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await params
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_READ)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_settings')
      .select(
        'payment_methods, kiosk_payment_methods, tab_pin_required, max_tab_hours, allow_split_bill, currency, timezone, tax_rate, service_charge, settings_version, updated_at'
      )
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    if (error) throw error

    const { count } = await supabase
      .from('restaurant_tables')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('is_kiosk', true)

    return NextResponse.json({
      settings: {
        ...(data ?? {}),
        hasKiosk: (count ?? 0) > 0,
        kiosk_payment_methods: data?.kiosk_payment_methods ?? ['cash', 'card', 'other'],
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load settings'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await params
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
    if (denied) return denied

    // Note: using user's linked restaurantId, ignoring URL param for security

    const body = await request.json()

    // Only allow known settings keys
    const updates: Record<string, unknown> = {}
    for (const key of ALLOWED_SETTINGS) {
      if (key in body) {
        updates[key] = body[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })
    }

    // Validate payment_methods if provided
    if (updates.payment_methods !== undefined) {
      const methods = updates.payment_methods as unknown[]
      if (!Array.isArray(methods) || methods.length === 0) {
        return NextResponse.json({ error: 'At least one payment method must be enabled' }, { status: 400 })
      }
      const valid = ['cash', 'card', 'online']
      if (!methods.every(m => valid.includes(String(m)))) {
        return NextResponse.json({ error: 'Invalid payment method' }, { status: 400 })
      }
    }

    if (updates.kiosk_payment_methods !== undefined) {
      const kioskMethods = updates.kiosk_payment_methods as unknown[]
      if (
        !Array.isArray(kioskMethods) ||
        kioskMethods.length === 0 ||
        !kioskMethods.every((m) => VALID_KIOSK_METHODS.includes(String(m)))
      ) {
        return NextResponse.json(
          { error: 'kiosk_payment_methods must be a non-empty array of: cash, card, other' },
          { status: 400 }
        )
      }
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('restaurant_settings')
      .upsert(
        { restaurant_id: restaurantId, ...updates },
        { onConflict: 'restaurant_id' }
      )
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, settings: data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update settings'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    console.error('[settings PATCH] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
