import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user
  try {
    user = await getUserFromRequest(req)
  } catch {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = createServerSupabaseClient()
  const { data: platformAdmin } = await supabase
    .from('platform_admins')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!platformAdmin) {
    return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 })
  }

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

    await supabase.from('platform_audit_logs').insert({
      actor_id: user.id,
      actor_email: user.email ?? '',
      action: 'feature_flags_updated',
      target_type: 'restaurant',
      target_id: id,
      payload: body,
      ip_address: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null,
      user_agent: req.headers.get('user-agent') ?? null,
      success: true,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[platform/features] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
