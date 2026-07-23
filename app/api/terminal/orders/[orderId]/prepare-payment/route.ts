import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { ensureTerminalMerchantOrderNo } from '@/lib/payments/terminal-merchant-order'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

/**
 * Allocates (or returns) the backend-owned Finatic merchant_order_no for a terminal POS
 * SALE and persists it on orders.paycloud_merchant_order_no BEFORE the device launches
 * WiseCashier. The terminal must pass this exact value as businessOrderNo so
 * POST /api/webhooks/paycloud can correlate via paycloud_merchant_order_no.
 *
 * Idempotent for an unpaid order: repeats return the same persisted value.
 * Does not mark the order paid and does not issue receipts (Phase 1 scope).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'orderId must be a valid UUID' }, { status: 400 })
    }

    try {
      const { merchantOrderNo, created } = await ensureTerminalMerchantOrderNo(supabase, {
        orderId,
        restaurantId: terminal.restaurantId,
      })

      console.log('[terminal/prepare-payment]', {
        orderId,
        restaurantId: terminal.restaurantId,
        terminalId: terminal.terminalId,
        merchantOrderNo,
        created,
      })

      return NextResponse.json({
        orderId,
        merchantOrderNo,
        created,
      })
    } catch (err: unknown) {
      const status =
        typeof err === 'object' && err && 'status' in err
          ? Number((err as { status: number }).status)
          : 500
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code: string }).code)
          : undefined
      const message = err instanceof Error ? err.message : 'Failed to prepare payment'

      if (status === 404) {
        return NextResponse.json({ error: message }, { status: 404 })
      }
      if (status === 400) {
        return NextResponse.json({ error: message, code }, { status: 400 })
      }
      console.error('[terminal/prepare-payment]', err)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/prepare-payment]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
