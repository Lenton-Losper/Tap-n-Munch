import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { excludeStressFixtures } from '@/lib/orders/stress-fixtures'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 1000

type OrderCountRow = {
  id: string
  placed_at: string
}

type PaidOrderRow = {
  restaurant_id: string | null
  total: number | string | null
  paid_at: string | null
  restaurants: unknown
}

function utcDayStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function dateKey(value: string | Date): string {
  return new Date(value).toISOString().slice(0, 10)
}

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

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const supabase = createServerSupabaseClient()
    const today = utcDayStart()
    const fourteenDayStart = new Date(today.getTime() - 13 * DAY_MS)
    const thirtyDayStart = new Date(today.getTime() - 29 * DAY_MS)
    const onlineSince = new Date(Date.now() - 15 * 60 * 1000).toISOString()

    const loadOrderCounts = async () => {
      const rows: OrderCountRow[] = []
      for (let offset = 0; ; offset += PAGE_SIZE) {
        /*
         * The 14-day window happens to sit past the 2026-04-27 fixture block, so this count is
         * right today. That is not a property worth relying on: it holds because the fixtures are
         * old, and it stops holding the moment anyone re-runs the stress script or widens this to
         * "all time". The exclusion states the intent instead of inheriting it from a date.
         */
        const { data, error } = await excludeStressFixtures(
          supabase.from('orders').select('id, placed_at'),
        )
          .gte('placed_at', fourteenDayStart.toISOString())
          .order('placed_at', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1)

        if (error) throw error
        const page = (data ?? []) as OrderCountRow[]
        rows.push(...page)
        if (page.length < PAGE_SIZE) break
      }
      return rows
    }

    const loadPaidOrders = async () => {
      const rows: PaidOrderRow[] = []
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await excludeStressFixtures(
          supabase
            .from('orders')
            .select('restaurant_id, total, paid_at, restaurants(name)'),
        )
          .eq('payment_status', 'paid')
          .gte('paid_at', thirtyDayStart.toISOString())
          .order('paid_at', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1)

        if (error) throw error
        const page = (data ?? []) as unknown as PaidOrderRow[]
        rows.push(...page)
        if (page.length < PAGE_SIZE) break
      }
      return rows
    }

    const [orders, paidOrders, activeTerminalsResult, onlineTerminalsResult] =
      await Promise.all([
        loadOrderCounts(),
        loadPaidOrders(),
        supabase
          .from('restaurant_terminals')
          .select('id', { count: 'exact', head: true })
          .eq('active', true)
          .eq('status', 'active'),
        supabase
          .from('restaurant_terminals')
          .select('id', { count: 'exact', head: true })
          .eq('active', true)
          .eq('status', 'active')
          .gte('last_seen_at', onlineSince),
      ])

    if (activeTerminalsResult.error) throw activeTerminalsResult.error
    if (onlineTerminalsResult.error) throw onlineTerminalsResult.error

    const daily = new Map<string, { date: string; orders: number; revenue: number }>()
    for (let index = 0; index < 14; index += 1) {
      const date = new Date(fourteenDayStart.getTime() + index * DAY_MS)
      const key = dateKey(date)
      daily.set(key, { date: key, orders: 0, revenue: 0 })
    }

    for (const order of orders) {
      const bucket = daily.get(dateKey(order.placed_at))
      if (bucket) bucket.orders += 1
    }

    for (const order of paidOrders) {
      if (!order.paid_at || order.paid_at < fourteenDayStart.toISOString()) continue
      const bucket = daily.get(dateKey(order.paid_at))
      if (bucket) bucket.revenue += Number(order.total || 0)
    }

    const revenueByRestaurant = new Map<
      string,
      { restaurantId: string; restaurantName: string | null; revenue: number }
    >()
    for (const order of paidOrders) {
      if (!order.restaurant_id) continue
      const current = revenueByRestaurant.get(order.restaurant_id) ?? {
        restaurantId: order.restaurant_id,
        restaurantName: restaurantName(order.restaurants),
        revenue: 0,
      }
      current.revenue += Number(order.total || 0)
      revenueByRestaurant.set(order.restaurant_id, current)
    }

    const series = Array.from(daily.values()).map((row) => ({
      ...row,
      revenue: Math.round(row.revenue * 100) / 100,
    }))
    const topRestaurants = Array.from(revenueByRestaurant.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((row) => ({
        ...row,
        revenue: Math.round(row.revenue * 100) / 100,
      }))

    const active = activeTerminalsResult.count ?? 0
    const online = onlineTerminalsResult.count ?? 0

    return NextResponse.json({
      series,
      topRestaurants,
      terminalUptime: {
        online,
        active,
        ratio: active > 0 ? Math.round((online / active) * 10000) / 10000 : null,
      },
    })
  } catch (error) {
    console.error('[platform/analytics] GET', error)
    return NextResponse.json({ error: 'Failed to load platform analytics.' }, { status: 500 })
  }
}
