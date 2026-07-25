import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    const record = await validateTerminalRecord(supabase, terminal)

    const [{ data: restaurant, error: restaurantError }, { data: settings, error: settingsError }] =
      await Promise.all([
        supabase.from('restaurants').select('name').eq('id', terminal.restaurantId).maybeSingle(),
        supabase
          .from('restaurant_settings')
          .select('payment_methods')
          .eq('restaurant_id', terminal.restaurantId)
          .maybeSingle(),
      ])

    if (restaurantError) {
      return NextResponse.json({ error: 'Failed to load restaurant' }, { status: 500 })
    }
    if (settingsError) {
      return NextResponse.json({ error: 'Failed to load restaurant settings' }, { status: 500 })
    }

    // Same fallback the order-creation path uses (app/api/orders/route.ts) when no
    // restaurant_settings row exists yet -- one definition of "enabled", not a second one.
    const paymentMethods: string[] = settings?.payment_methods ?? ['cash', 'card']

    return NextResponse.json({
      terminalId: terminal.terminalId,
      restaurantId: terminal.restaurantId,
      restaurantName: String(restaurant?.name || 'Restaurant'),
      status: String(record.status || 'active'),
      permissions: terminal.permissions,
      cardPaymentEnabled: paymentMethods.includes('card'),
      cashPaymentEnabled: paymentMethods.includes('cash'),
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
