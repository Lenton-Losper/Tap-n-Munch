import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  requirePlatformRole,
  writePlatformAudit,
} from '@/lib/permissions/assert-platform-admin'
import { FEATURE_FLAG_KEYS } from '@/app/admin/restaurants/[id]/constants'

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

    // Was a hand-maintained literal, drifted from FEATURE_FLAG_KEYS (the docblock there already
    // claimed this route was driven by it) -- importing it means a new flag is added in one
    // place, not two kept in sync by hand.
    const safeUpdates = Object.fromEntries(
      Object.entries(body).filter(([k]) => (FEATURE_FLAG_KEYS as readonly string[]).includes(k))
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
