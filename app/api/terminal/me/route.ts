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
        supabase
          .from('restaurants')
          .select('name, is_counter_service')
          .eq('id', terminal.restaurantId)
          .maybeSingle(),
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
      /**
       * ADR-005 -- THE VENUE SERVICE MODEL, so the device can decide which ordering surface to
       * show. `is_counter_service` is `boolean NOT NULL DEFAULT false` (20260824120000):
       * TRUE = counter service, FALSE = table service.
       *
       * WHY HERE AND NOT IN THE TERMINAL JWT. The token lives an hour and is minted at
       * activation or refresh, so a venue switching service model would wait up to an hour for
       * the change to reach a device -- and a device that had not refreshed would keep showing
       * the wrong ordering surface with nothing reporting it. This endpoint is polled, so the
       * answer is current.
       *
       * WHY NOT LET THE DEVICE READ THE COLUMN DIRECTLY. `anon` was granted SELECT on it
       * (20260824130000) for the guest web client, and the terminal does hold an anon key -- so
       * it COULD. That would route a venue-behaviour decision around the terminal auth surface
       * entirely and make it part of no contract. It belongs here, next to the other two
       * capability flags the device already switches on.
       *
       * Purely additive: every existing APK ignores an unknown field.
       */
      isCounterService: restaurant?.is_counter_service === true,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
