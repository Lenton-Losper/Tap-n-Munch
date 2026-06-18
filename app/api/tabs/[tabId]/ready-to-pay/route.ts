import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { requireSessionToken } from '@/lib/session-guard'

export const dynamic = 'force-dynamic'

const VALID_PREFERENCES = new Set(['cash', 'card', 'other'])

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params
  const normalizedTabId = String(tabId || '').trim()

  console.log('[TABS] ready-to-pay request', { tabId: normalizedTabId })

  if (!normalizedTabId) {
    return NextResponse.json({ error: 'Missing tab id' }, { status: 400 })
  }

  const guard = await requireSessionToken(req)
  if (guard.error) return guard.error

  try {
    const body = await req.json().catch(() => ({}))
    const restaurantId = String(body.restaurantId ?? body.restaurant_id ?? '').trim()
    const paymentPreference = String(body.paymentPreference ?? body.payment_preference ?? '').trim()

    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }
    if (!VALID_PREFERENCES.has(paymentPreference)) {
      return NextResponse.json({ error: 'Invalid payment preference' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    const supabase = createServerSupabaseClient()

    const { data: tab, error: loadError } = await supabase
      .from('tabs')
      .select('id, status, restaurant_id')
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantUuid)
      .maybeSingle()

    if (loadError) {
      console.error('[TABS] ready-to-pay load error', loadError)
      return NextResponse.json({ error: loadError.message }, { status: 500 })
    }
    if (!tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    const status = String(tab.status || '')
    if (status === 'ready_to_pay') {
      console.log('[TABS] ready-to-pay already set', normalizedTabId)
      return NextResponse.json({ success: true, tabId: normalizedTabId, status: 'ready_to_pay' })
    }
    if (status !== 'open') {
      return NextResponse.json({ error: `Tab cannot be marked ready (status=${status})` }, { status: 400 })
    }

    const { data: updatedTab, error: updateError } = await supabase
      .from('tabs')
      .update({
        status: 'ready_to_pay',
        payment_preference: paymentPreference,
        ready_to_pay_at: new Date().toISOString(),
      })
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantUuid)
      .neq('status', 'ready_to_pay')
      .select('id, status, payment_preference')
      .maybeSingle()

    if (updateError) {
      console.error('[TABS] ready-to-pay update error', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    if (!updatedTab) {
      return NextResponse.json(
        {
          success: false,
          message: 'This tab has already been marked ready to pay.',
          alreadyReady: true,
        },
        { status: 409 }
      )
    }

    console.log('[TABS] ready-to-pay success', normalizedTabId, updatedTab)
    return NextResponse.json({
      success: true,
      tabId: normalizedTabId,
      status: 'ready_to_pay',
      payment_preference: updatedTab.payment_preference,
    })
  } catch (err) {
    console.error('[TABS] ready-to-pay unexpected error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
