import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { PDF_EMAIL_UNAVAILABLE_MESSAGE } from '@/lib/reports/pdf-email-unavailable'

export const dynamic = 'force-dynamic'

// PATCH — update a schedule (toggle enabled, change email/format/time)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; scheduleId: string }> }
) {
  try {
    await getUserFromRequest(request)
    const { id, scheduleId } = await params
    const body = await request.json()

    const allowed = ['enabled', 'email', 'format', 'send_time', 'timezone']
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) updates[key] = body[key]
    }
    if (updates.format === 'pdf') {
      return NextResponse.json({ error: PDF_EMAIL_UNAVAILABLE_MESSAGE }, { status: 503 })
    }
    updates.updated_at = new Date().toISOString()

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('report_schedules')
      .update(updates)
      .eq('id', scheduleId)
      .eq('restaurant_id', id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ schedule: data })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update schedule'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE — remove a schedule
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; scheduleId: string }> }
) {
  try {
    await getUserFromRequest(request)
    const { id, scheduleId } = await params
    const supabase = createServerSupabaseClient()
    const { error } = await supabase
      .from('report_schedules')
      .delete()
      .eq('id', scheduleId)
      .eq('restaurant_id', id)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete schedule'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
