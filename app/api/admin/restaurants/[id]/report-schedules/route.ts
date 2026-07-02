import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { PDF_EMAIL_UNAVAILABLE_MESSAGE } from '@/lib/reports/pdf-email-unavailable'

export const dynamic = 'force-dynamic'

// GET — fetch all schedules for this restaurant
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await getUserFromRequest(request)
    const { id } = await params
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('report_schedules')
      .select('*')
      .eq('restaurant_id', id)
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ schedules: data ?? [] })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch schedules'
    return NextResponse.json({ error: message }, { status: 401 })
  }
}

// POST — create a new schedule for this restaurant
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await getUserFromRequest(request)
    const { id } = await params
    const body = await request.json()
    const { email, format, send_time, timezone, enabled } = body

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required' }, { status: 400 })
    }
    if (!['pdf', 'csv'].includes(format)) {
      return NextResponse.json({ error: 'format must be pdf or csv' }, { status: 400 })
    }
    if (format === 'pdf') {
      return NextResponse.json({ error: PDF_EMAIL_UNAVAILABLE_MESSAGE }, { status: 503 })
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('report_schedules')
      .insert({
        restaurant_id: id,
        email,
        format: 'csv',
        send_time: send_time ?? '20:00',
        timezone: timezone ?? 'Africa/Windhoek',
        enabled: enabled ?? true,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ schedule: data })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create schedule'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
