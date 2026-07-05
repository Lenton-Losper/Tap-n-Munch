import { NextResponse } from 'next/server'
import { buildOnboardingTableQrUrl } from '@/lib/onboarding/qr-url'
import { markSetupStepComplete } from '@/lib/onboarding/setup-status-server'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.TABLES_MANAGE, request)
    if (isAuthError(auth)) return auth

    const { supabase, restaurantId } = auth
    const body = await request.json()
    const count = Number(body?.count)

    if (!Number.isFinite(count) || count < 1 || count > 200) {
      return NextResponse.json(
        { error: 'Table count must be between 1 and 200' },
        { status: 400 },
      )
    }

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
    console.error('[tables/generate] failed:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
