import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { excludeStressFixtures } from '@/lib/orders/stress-fixtures'

export const dynamic = 'force-dynamic'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function restaurantName(relation: unknown): string | null {
  if (Array.isArray(relation)) {
    const first = relation[0]
    return first && typeof first === 'object' && 'name' in first
      ? String(first.name)
      : null
  }
  if (relation && typeof relation === 'object' && 'name' in relation) {
    return String(relation.name)
  }
  return null
}

function uniqueById(rows: Array<Record<string, unknown>>, limit: number) {
  const seen = new Set<string>()
  const unique: Array<Record<string, unknown>> = []

  for (const row of rows) {
    const id = String(row.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push({
      ...row,
      restaurant_name: restaurantName(row.restaurants),
    })
    if (unique.length >= limit) break
  }

  return unique
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  const query = new URL(request.url).searchParams.get('q')?.trim() || ''
  if (!query) {
    return NextResponse.json({ error: 'q is required.' }, { status: 400 })
  }

  try {
    const supabase = createServerSupabaseClient()
    const pattern = `%${query}%`
    const orderSelect =
      'id, restaurant_id, order_number, status, payment_status, payment_method, total, paycloud_merchant_order_no, payment_reference, payment_voucher_no, placed_at, paid_at, restaurants(name)'

    // Unscoped by design -- a payment lookup spans every venue -- so each leg excludes the
    // stress fixtures. A fixture carries none of these three references, so nothing changes today;
    // the filter is here so that stays true by rule rather than by coincidence.
    const orderQueries = [
      excludeStressFixtures(
        supabase
          .from('orders')
          .select(orderSelect)
          .ilike('paycloud_merchant_order_no', pattern)
          .order('placed_at', { ascending: false })
          .limit(30),
      ),
      excludeStressFixtures(
        supabase
          .from('orders')
          .select(orderSelect)
          .ilike('payment_reference', pattern)
          .order('placed_at', { ascending: false })
          .limit(30),
      ),
      excludeStressFixtures(
        supabase
          .from('orders')
          .select(orderSelect)
          .ilike('payment_voucher_no', pattern)
          .order('placed_at', { ascending: false })
          .limit(30),
      ),
    ]

    if (UUID_PATTERN.test(query)) {
      orderQueries.push(
        supabase
          .from('orders')
          .select(orderSelect)
          .eq('id', query)
          .limit(1),
      )
    }

    const [orderResults, eventResult] = await Promise.all([
      Promise.all(orderQueries),
      supabase
        .from('payment_events')
        .select(
          'id, restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no, transaction_id, amount, currency, gateway_result_code, gateway_result_message, created_at, restaurants(name)',
        )
        .ilike('business_order_no', pattern)
        .order('created_at', { ascending: false })
        .limit(30),
    ])

    const queryError =
      orderResults.find((result) => result.error)?.error ?? eventResult.error
    if (queryError) throw queryError

    const orderRows = orderResults.flatMap(
      (result) => (result.data ?? []) as unknown as Array<Record<string, unknown>>,
    )
    const eventRows = (eventResult.data ?? []) as unknown as Array<
      Record<string, unknown>
    >

    return NextResponse.json({
      query,
      orders: uniqueById(orderRows, 30),
      paymentEvents: uniqueById(eventRows, 30),
    })
  } catch (error) {
    console.error('[platform/payments/lookup] GET', error)
    return NextResponse.json({ error: 'Payment lookup failed.' }, { status: 500 })
  }
}
