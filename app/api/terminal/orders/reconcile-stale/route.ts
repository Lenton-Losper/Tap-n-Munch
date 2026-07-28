import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'
import { stagingFinaticQueryStub } from '@/lib/payments/staging-finatic-stub'

export const dynamic = 'force-dynamic'

/**
 * Staging-only HTTP probe hook for restaurant-scoped stale POS reconciliation.
 * Lets us exercise the deployed Worker over terminal auth without requiring the
 * cron secret in local/dev tooling.
 */
export async function POST(req: Request) {
  try {
    if (String(process.env.ENVIRONMENT || '').trim().toLowerCase() !== 'staging') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const result = await autoCancelStalePosOrders(supabase, {
      restaurantId: terminal.restaurantId,
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: stagingFinaticQueryStub(body?.__stagingFinaticStub),
    })

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/reconcile-stale]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
