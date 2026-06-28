import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const supabase = createServerSupabaseClient()
    const updates = await req.json()

    const allowedKeys = [
      'kitchen_enabled', 'inventory_enabled', 'analytics_enabled',
      'split_bill_enabled', 'reservations_enabled', 'loyalty_enabled',
      'online_payments_enabled', 'multi_branch_enabled', 'staff_app_enabled',
      'kiosk_enabled', 'whatsapp_enabled',
    ]

    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => allowedKeys.includes(k))
    )

    if (Object.keys(safeUpdates).length === 0)
      return NextResponse.json({ error: 'No valid fields' }, { status: 400 })

    const { error } = await supabase
      .from('restaurant_features')
      .upsert(
        { restaurant_id: id, ...safeUpdates, updated_at: new Date().toISOString() },
        { onConflict: 'restaurant_id' }
      )

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[platform/features] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
