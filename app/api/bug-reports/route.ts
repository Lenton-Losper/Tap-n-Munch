import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

/**
 * Staff-facing bug report intake (restaurant dashboard "Report a Bug").
 * Persists to bug_reports for the platform ops inbox.
 */
export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()

    const { data: membership } = await supabase
      .from('restaurant_users')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()

    const body = (await request.json().catch(() => ({}))) as {
      description?: string
      area?: string
      reporterName?: string
      pageUrl?: string
      restaurantId?: string
    }

    const description = String(body.description || '').trim()
    if (!description) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    const restaurantId =
      String(body.restaurantId || '').trim() || membership?.restaurant_id || null

    const { data, error } = await supabase
      .from('bug_reports')
      .insert({
        restaurant_id: restaurantId,
        description,
        area: body.area?.trim() || 'Other',
        reporter_user_id: user.id,
        reporter_name: body.reporterName?.trim() || null,
        page_url: body.pageUrl?.trim() || null,
        status: 'open',
      })
      .select('id')
      .single()

    if (error) throw error
    return NextResponse.json({ id: data.id, success: true })
  } catch (err) {
    console.error('[bug-reports] POST', err)
    return NextResponse.json({ error: 'Failed to submit bug report' }, { status: 500 })
  }
}
