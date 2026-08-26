import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { attachRestaurantNames } from '@/lib/platform/attach-restaurant-names'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { excludeStressFixtures } from '@/lib/orders/stress-fixtures'

export const dynamic = 'force-dynamic'

function uniqueById(rows: Array<Record<string, unknown>>, limit = 10) {
  const seen = new Set<string>()
  const unique: Array<Record<string, unknown>> = []

  for (const row of rows) {
    const id = String(row.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push(row)
    if (unique.length >= limit) break
  }

  return unique
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  const query = new URL(request.url).searchParams.get('q')?.trim() || ''
  if (query.length < 2) {
    return NextResponse.json({
      restaurants: [],
      terminals: [],
      orders: [],
      bugs: [],
    })
  }

  try {
    const supabase = createServerSupabaseClient()
    const pattern = `%${query}%`
    const terminalSelect =
      'id, restaurant_id, sn, device_serial, name, terminal_name, model, status, active, app_version, last_seen_at, restaurants(name)'
    const orderSelect =
      'id, restaurant_id, order_number, status, payment_status, total, paycloud_merchant_order_no, payment_reference, payment_voucher_no, placed_at, restaurants(name)'

    const restaurantQueries = [
      supabase
        .from('restaurants')
        .select('id, name, slug, is_active, created_at')
        .ilike('name', pattern)
        .limit(10),
      supabase
        .from('restaurants')
        .select('id, name, slug, is_active, created_at')
        .ilike('slug', pattern)
        .limit(10),
    ]
    const terminalQueries = [
      supabase
        .from('restaurant_terminals')
        .select(terminalSelect)
        .ilike('sn', pattern)
        .limit(10),
      supabase
        .from('restaurant_terminals')
        .select(terminalSelect)
        .ilike('name', pattern)
        .limit(10),
      supabase
        .from('restaurant_terminals')
        .select(terminalSelect)
        .ilike('terminal_name', pattern)
        .limit(10),
    ]
    /*
     * EVERY ORDER QUERY HERE IS UNSCOPED — platform search deliberately spans all venues — so every
     * one of them carries the stress-fixture exclusion.
     *
     * THE order_number QUERY IS NOT HYPOTHETICAL. Measured on production 2026-08-26: searching
     * order number 142 returned 8 fixtures in the top 10, and order number 1 returned 6 of 10. The
     * fixtures occupy order_number 1..146 with up to 45 rows on a single number, and this query
     * sorts by placed_at and takes 10 — so a platform admin looking up a real order was being
     * handed debris in place of it. The three `ilike` queries are excluded today by value (a
     * fixture carries no merchant order number, reference or voucher), but they get the filter too:
     * "safe because of what the rows happen to contain" is not a property anyone maintains.
     */
    const orderQueries = [
      excludeStressFixtures(
        supabase
          .from('orders')
          .select(orderSelect)
          .ilike('paycloud_merchant_order_no', pattern)
          .order('placed_at', { ascending: false })
          .limit(10),
      ),
      excludeStressFixtures(
        supabase
          .from('orders')
          .select(orderSelect)
          .ilike('payment_reference', pattern)
          .order('placed_at', { ascending: false })
          .limit(10),
      ),
      excludeStressFixtures(
        supabase
          .from('orders')
          .select(orderSelect)
          .ilike('payment_voucher_no', pattern)
          .order('placed_at', { ascending: false })
          .limit(10),
      ),
    ]

    if (/^\d{1,10}$/.test(query)) {
      orderQueries.push(
        excludeStressFixtures(
          supabase
            .from('orders')
            .select(orderSelect)
            .eq('order_number', Number(query))
            .order('placed_at', { ascending: false })
            .limit(10),
        ),
      )
    }

    const [restaurantResults, terminalResults, orderResults, bugResult] =
      await Promise.all([
        Promise.all(restaurantQueries),
        Promise.all(terminalQueries),
        Promise.all(orderQueries),
        // Avoid status + restaurants(name) until ops migration/FK are applied.
        supabase
          .from('bug_reports')
          .select('id, restaurant_id, description, area, created_at')
          .ilike('description', pattern)
          .order('created_at', { ascending: false })
          .limit(10),
      ])

    const allResults = [
      ...restaurantResults,
      ...terminalResults,
      ...orderResults,
      bugResult,
    ]
    const queryError = allResults.find((result) => result.error)?.error
    if (queryError) throw queryError

    const rows = (results: typeof restaurantResults) =>
      results.flatMap(
        (result) => (result.data ?? []) as unknown as Array<Record<string, unknown>>,
      )

    const bugs = await attachRestaurantNames(
      supabase,
      uniqueById((bugResult.data ?? []) as unknown as Array<Record<string, unknown>>),
    )

    return NextResponse.json({
      restaurants: uniqueById(rows(restaurantResults)),
      terminals: uniqueById(
        terminalResults.flatMap(
          (result) =>
            (result.data ?? []) as unknown as Array<Record<string, unknown>>,
        ),
      ),
      orders: uniqueById(
        orderResults.flatMap(
          (result) =>
            (result.data ?? []) as unknown as Array<Record<string, unknown>>,
        ),
      ),
      bugs,
    })
  } catch (error) {
    console.error('[platform/search] GET', error)
    return NextResponse.json({ error: 'Platform search failed.' }, { status: 500 })
  }
}
