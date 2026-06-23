import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getRestaurantIdForUser,
  getUserFromRequest,
} from '@/lib/supabase/admin-restaurant-auth'
import { buildOnboardingTableQrUrl } from '@/lib/onboarding/qr-url'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const count = Number(body?.count)

    if (!Number.isFinite(count) || count < 1 || count > 200) {
      return NextResponse.json(
        { error: 'Table count must be between 1 and 200' },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    const { data: existingTables, error: existingError } = await supabase
      .from('restaurant_tables')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('table_number')

    if (existingError) throw existingError

    if (existingTables && existingTables.length > 0) {
      await markSetupStepComplete(supabase, restaurantId, 'tables_configured')
      return NextResponse.json({ tables: existingTables, skipped: true })
    }

    const rows = Array.from({ length: count }, (_, index) => {
      const tableNumber = index + 1
      return {
        restaurant_id: restaurantId,
        table_number: tableNumber,
        table_name: `Table ${tableNumber}`,
        qr_code_url: buildOnboardingTableQrUrl(restaurantId, tableNumber),
        active: true,
      }
    })

    const { data: tables, error: insertError } = await supabase
      .from('restaurant_tables')
      .insert(rows)
      .select('*')

    if (insertError) throw insertError

    await markSetupStepComplete(supabase, restaurantId, 'tables_configured')

    return NextResponse.json({ tables: tables || [], skipped: false })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to generate tables'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[tables/generate] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
