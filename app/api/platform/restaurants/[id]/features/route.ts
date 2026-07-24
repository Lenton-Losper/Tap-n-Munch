import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  requirePlatformRole,
  writePlatformAudit,
} from '@/lib/permissions/assert-platform-admin'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requirePlatformRole(req, ['super_admin'])
  if (admin instanceof NextResponse) return admin

  const supabase = createServerSupabaseClient()
  const { id } = await params
  try {
    const body = await req.json()

    const allowedKeys = [
      'kitchen_enabled', 'inventory_enabled', 'analytics_enabled',
      'split_bill_enabled', 'reservations_enabled', 'loyalty_enabled',
      'online_payments_enabled', 'multi_branch_enabled', 'staff_app_enabled',
      'kiosk_enabled', 'whatsapp_enabled',
    ]

    const safeUpdates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowedKeys.includes(k))
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

    await writePlatformAudit({
      actorId: admin.userId,
      actorEmail: admin.email,
      action: 'feature_flags_updated',
      targetType: 'restaurant',
      targetId: id,
      payload: safeUpdates,
      request: req,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[platform/features] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
