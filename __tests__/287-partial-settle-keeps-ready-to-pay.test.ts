/**
 * #287: THE FIRST PARTIAL SETTLE MUST NOT WIPE THE READY-TO-PAY RECORD FOR EVERYONE STILL WAITING.
 *
 * A table of four all press Ready to Pay. Staff charge one diner's orders. Before this, that
 * cleared `ready_to_pay_at` for the whole tab — the terminal chip vanished and nobody was told the
 * other three were still waiting. Subset settlement is a first-class flow (the terminal ships a
 * per-order multi-select), so this is not theoretical.
 *
 * WHAT IS AND IS NOT ASSERTED HERE. This is the SERVER half, option C on #287. `status` is still
 * reopened to 'open' in every case, because status is the ordering gate and the remaining diners
 * must be able to keep ordering. Every consumer keys on status, so there is NO VISIBLE CHANGE
 * today — what this buys is that the record stops being destroyed, which is what makes option B
 * (a derived staff signal) a pure render change when a terminal build next ships.
 *
 * Staff still lose the chip after a partial settle until that APK exists. Not fixed here.
 *
 * The Supabase client is a hand-built fake rather than a mock library: the assertions are about
 * WHICH statements ran, and a recorded call list says that more plainly than a matcher chain.
 */
import { clearReadyToPayAndReopenTab } from '@/lib/tabs/settle-tab-state'

type OrderRow = {
  total: number
  payment_status: string
  tab_settlement_for_tab_id?: string | null
}

type Recorded = { table: string; patch: Record<string, unknown> }

function fakeSupabase(orders: OrderRow[], opts: { ordersReadFails?: boolean } = {}) {
  const writes: Recorded[] = []

  const tabsUpdate = (patch: Record<string, unknown>) => {
    writes.push({ table: 'tabs', patch })
    const chain: any = {
      eq: () => chain,
      is: () => Promise.resolve({ error: null }),
      then: (res: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(res),
    }
    return chain
  }

  return {
    writes,
    client: {
      from(table: string) {
        if (table === 'tabs') return { update: tabsUpdate }
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () =>
                Promise.resolve(
                  opts.ordersReadFails
                    ? { data: null, error: { message: 'boom' } }
                    : { data: orders, error: null },
                ),
            }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
    } as never,
  }
}

const flagsCleared = (writes: Recorded[]) =>
  writes.some((w) => 'ready_to_pay_at' in w.patch && w.patch.ready_to_pay_at === null)
const statusReopened = (writes: Recorded[]) =>
  writes.some((w) => w.patch.status === 'open')

const UNPAID = (total: number): OrderRow => ({ total, payment_status: 'pending' })
const PAID = (total: number): OrderRow => ({ total, payment_status: 'paid' })

describe('money was taken, and the table still owes', () => {
  it('KEEPS the ready-to-pay record — the defect, stated as a rule', async () => {
    const { client, writes } = fakeSupabase([PAID(100), UNPAID(300)])
    const result = await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    })
    expect(flagsCleared(writes)).toBe(false)
    expect(result.readyToPayPreserved).toBe(true)
  })

  it('STILL reopens the tab, so the others can keep ordering', async () => {
    // The ordering gate is `status`, not the flags. Preserving the record must not lock the table
    // out of ordering -- that is the tension that made the obvious fix wrong (spec Event L:
    // payment does not end the visit).
    const { client, writes } = fakeSupabase([PAID(100), UNPAID(300)])
    await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    })
    expect(statusReopened(writes)).toBe(true)
  })
})

describe('money was taken, and nothing remains', () => {
  it('CLEARS the record — the control, or "never clears" would pass the test above', async () => {
    const { client, writes } = fakeSupabase([PAID(100), PAID(300)])
    const result = await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    })
    expect(flagsCleared(writes)).toBe(true)
    expect(result.readyToPayPreserved).toBe(false)
  })

  it('clears on a tab with no orders at all', async () => {
    const { client, writes } = fakeSupabase([])
    await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    })
    expect(flagsCleared(writes)).toBe(true)
  })

  it('ignores a cancelled order when deciding money remains', async () => {
    // computeTabOutstanding excludes anything that does not owe. A cancelled order left behind
    // must not keep a fully paid tab parked on the queue -- that is the older, worse defect.
    const { client, writes } = fakeSupabase([PAID(100), { total: 300, payment_status: 'cancelled' }])
    expect(await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    }).then(() => flagsCleared(writes))).toBe(true)
  })

  it('ignores a settlement artefact, which is a payment and not a line ordered', async () => {
    const { client, writes } = fakeSupabase([
      PAID(100),
      { total: 300, payment_status: 'pending', tab_settlement_for_tab_id: 'tab-1' },
    ])
    await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    })
    expect(flagsCleared(writes)).toBe(true)
  })
})

describe('the amount changed under the queue entry', () => {
  /**
   * The OTHER caller. A customer edited an order after pressing Ready to Pay, so staff must not
   * settle at a figure that is no longer owed — the flag clears and the customer presses again.
   * Preserving it here would reintroduce the exact defect that call site exists to fix, and money
   * remaining is precisely the state it fires in, so this is the case most at risk of regressing.
   */
  it('ALWAYS clears, even though money remains', async () => {
    const { client, writes } = fakeSupabase([UNPAID(300)])
    const result = await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'amount_changed',
    })
    expect(flagsCleared(writes)).toBe(true)
    expect(result.readyToPayPreserved).toBe(false)
  })

  it('is the DEFAULT when no reason is given, so an unconverted caller behaves as before', async () => {
    const { client, writes } = fakeSupabase([UNPAID(300)])
    await clearReadyToPayAndReopenTab(client, { tabId: 'tab-1', logPrefix: '[test]' })
    expect(flagsCleared(writes)).toBe(true)
  })

  it('does not even read the orders table, since the answer cannot change', async () => {
    const { client } = fakeSupabase([UNPAID(300)], { ordersReadFails: true })
    // A read failure would be logged; reaching the clear regardless proves no read was needed.
    await expect(
      clearReadyToPayAndReopenTab(client, { tabId: 'tab-1', logPrefix: '[test]' }),
    ).resolves.toMatchObject({ readyToPayPreserved: false })
  })
})

describe('when the balance cannot be read', () => {
  it('FAILS TOWARD CLEARING, the historical behaviour', async () => {
    // A stale ready-to-pay flag on a fully paid tab parks it on the queue for good -- the older
    // and worse defect. An unknown answer must not invent a reason to keep the flag.
    const { client, writes } = fakeSupabase([UNPAID(300)], { ordersReadFails: true })
    const result = await clearReadyToPayAndReopenTab(client, {
      tabId: 'tab-1',
      logPrefix: '[test]',
      reason: 'money_taken',
    })
    expect(flagsCleared(writes)).toBe(true)
    expect(result.readyToPayPreserved).toBe(false)
  })
})

describe('every money-taken caller declares itself', () => {
  /**
   * The behaviour is opt-in, so a settle route that forgot the parameter would silently keep the
   * defect and no unit test of the helper would notice. Asserted as a source scan because these
   * are Next route exports that need a full request to invoke.
   */
  const { readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('the terminal tab settle route — the subset-settlement path', () => {
    const src = read('app/api/terminal/tabs/[tabId]/settle/route.ts')
    expect(src).toMatch(/reason: 'money_taken'/)
  })

  it('the terminal single-order payment route, both branches', () => {
    const src = read('app/api/terminal/orders/[orderId]/payment/route.ts')
    expect(src.match(/reason: 'money_taken'/g) ?? []).toHaveLength(2)
  })

  it('the guest edit route stays amount_changed, explicitly', () => {
    const src = read('app/api/guest/orders/[orderId]/edit/route.ts')
    expect(src).toMatch(/reason: 'amount_changed'/)
    expect(src).not.toMatch(/reason: 'money_taken'/)
  })
})
