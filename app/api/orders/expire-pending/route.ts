import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

const TEN_MIN_MS = 10 * 60 * 1000

async function runExpire() {
  const supabase = createServerSupabaseClient()
  const tenMinutesAgo = new Date(Date.now() - TEN_MIN_MS).toISOString()

  const { data: expiredOrders, error } = await supabase
    .from('orders')
    .update({
      payment_status: 'cancelled',
      status: 'cancelled',
    })
    .eq('payment_status', 'pending')
    .eq('payment_channel', 'hosted')
    .lt('placed_at', tenMinutesAgo)
    .select('id, restaurant_id, table_number, tab_id')

  if (error) {
    console.error('[EXPIRE-PENDING] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = expiredOrders || []
  console.log('[EXPIRE-PENDING] Cancelled', rows.length, 'abandoned orders')

  const nowIso = new Date().toISOString()
  const seenTabs = new Set<string>()

  for (const order of rows) {
    const tabId = order.tab_id ? String(order.tab_id).trim() : ''
    if (!tabId || seenTabs.has(tabId)) continue
    seenTabs.add(tabId)

    const { data: activeOrders } = await supabase
      .from('orders')
      .select('id')
      .eq('tab_id', tabId)
      .neq('status', 'cancelled')

    if (!activeOrders || activeOrders.length === 0) {
      const { error: tabErr } = await supabase
        .from('tabs')
        .update({
          status: 'closed',
          closed_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', tabId)

      if (tabErr) {
        console.warn('[EXPIRE-PENDING] Tab close failed:', tabId, tabErr)
      } else {
        console.log('[EXPIRE-PENDING] Closed abandoned tab:', tabId)
      }
    }
  }

  return NextResponse.json({
    success: true,
    expired: rows.length,
  })
}

export async function POST() {
  return runExpire()
}

export async function GET() {
  return runExpire()
}
