import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

const ALLOWED_SETTINGS = [
  'payment_methods',
  'tab_pin_required',
  'max_tab_hours',
  'allow_split_bill',
  'currency',
  'timezone',
  'tax_rate',
  'service_charge',
]

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('restaurant_settings')
      .select('payment_methods, tab_pin_required, max_tab_hours, allow_split_bill, currency, timezone, tax_rate, service_charge, settings_version, updated_at')
      .eq('restaurant_id', id)
      .maybeSingle()
    if (error) throw error
    return NextResponse.json({ settings: data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load settings'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)

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
