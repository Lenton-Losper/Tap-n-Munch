import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { getGratuityReport } from '@/lib/reports/gratuity-report'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/restaurants/{id}/reports/gratuities?from=&to=
 *
 * Total gratuities over a period, broken down by staff member.
 *
 * GATED ON analytics:view, the same permission the rest of reporting uses. Not on a new one:
 * seeing what the venue took in tips is reading the venue's numbers, which is what that
 * permission already means. Inventing a permission here would leave every existing manager
 * unable to see it until somebody remembered to grant it.
 *
 * READ-ONLY, AND NOT REVENUE. It reads `payment_tips` alone. `totalRevenue` elsewhere derives
 * from ORDERS and must stay that way — a gratuity is not a sale, and the separation is structural
 * rather than a filter someone can remove.
 *
 * THE FIGURES ARE A RECORD OF WHAT WAS KEYED, NOT PROOF OF WHO EARNED WHAT. Attribution comes
 * from an unverified picker on the terminal; a mis-tap puts one person's gratuity against
 * another's name and this repeats it faithfully. The UI says so; so does this.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user
  try {
    user = await getUserFromRequest(request)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    return NextResponse.json({ error: message }, { status: 401 })
  }

  try {
    const { id } = await params
    const restaurantId = String(id ?? '').trim()
    if (!restaurantId) {
      return NextResponse.json({ error: 'Restaurant id is required' }, { status: 400 })
    }

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.ANALYTICS_VIEW)
    if (denied) return denied

    const url = new URL(request.url)
    const from = String(url.searchParams.get('from') || '').trim()
    const to = String(url.searchParams.get('to') || '').trim()
    if (!from || !to) {
      return NextResponse.json(
        { error: 'from and to are required (ISO dates)', code: 'RANGE_REQUIRED' },
        { status: 400 },
      )
    }

    const fromDate = new Date(from)
    const toDate = new Date(to)
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return NextResponse.json({ error: 'from and to must be dates', code: 'RANGE_INVALID' }, { status: 400 })
    }
    /**
     * REFUSED, NOT SILENTLY SWAPPED. A reversed range is a mistake in the caller, and quietly
     * fixing it would return a period nobody asked for under a heading that says otherwise.
     */
    if (fromDate.getTime() >= toDate.getTime()) {
      return NextResponse.json(
        { error: 'from must be before to', code: 'RANGE_REVERSED' },
        { status: 400 },
      )
    }

    const supabase = createServerSupabaseClient()
    const report = await getGratuityReport(supabase, {
      restaurantId,
      fromIso: fromDate.toISOString(),
      toIso: toDate.toISOString(),
    })

    return NextResponse.json(report)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to build the gratuity report'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
