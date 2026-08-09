/**
 * Issue #104, fifth call site — found by the verification seat after the first four were fixed.
 *
 * lib/payments/mark-order-paid-confirmed.ts recomputes tabs.total from
 * `.neq('payment_status', 'paid')`, which is true of a CANCELLED order. Same question, same
 * defect, same chain as the four fixed in c566d9b: markOrderPaidConfirmed() is called from
 * app/api/terminal/orders/[orderId]/payment/route.ts, two statements before the canClose read
 * that commit corrected.
 *
 * That left the two DISAGREEING inside a single request -- canClose said the tab was clear
 * while tabs.total still carried the cancelled order's money -- and /api/terminal/tables
 * returns both `tab.total` and `unpaid_total` in one payload, so which figure staff saw
 * depended on the APK. Before c566d9b both were wrong and at least agreed.
 *
 * Tested against the real helper (the route-level suite mocks it, so it could not see this).
 */
import { OWES_MONEY_PAYMENT_STATUSES } from '@/lib/payments/payment-integrity'

const RESTAURANT_ID = 'rest-1'
const TAB_ID = 'tab-1'
const ORDER_ID = 'o-pending'

type Row = Record<string, any>

let mockOrders: Row[] = []
let tabTotalWrites: number[] = []

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async () => undefined,
  safeIssueReceiptsForOrders: async () => undefined,
}))

/**
 * Filters and updates for real, so the same assertions are valid against the SQL filter
 * (before) and the JS partition (after). Only the operators this helper actually uses.
 */
function makeClient() {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let patch: Row | null = null
      let columns: string | undefined

      const rows = () => mockOrders.filter((r) => preds.every((p) => p(r)))

      const api: Record<string, any> = {
        select(cols?: string) {
          columns = cols
          return api
        },
        eq(col: string, val: unknown) {
          preds.push((r) => r[col] === val)
          return api
        },
        neq(col: string, val: unknown) {
          preds.push((r) => r[col] !== val)
          return api
        },
        in(col: string, vals: unknown[]) {
          preds.push((r) => vals.includes(r[col]))
          return api
        },
        update(next: Row) {
          patch = next
          return api
        },
        insert: async () => ({ error: null }),
        async maybeSingle() {
          const found = rows()
          if (patch) for (const r of found) Object.assign(r, patch)
          if (found.length !== 1) return { data: null, error: null }
          return { data: { ...found[0] }, error: null }
        },
        then(resolve: (r: { data: Row[]; error: null }) => unknown) {
          const found = rows()
          if (patch) {
            // tabs.total write -- record the figure the helper decided on.
            if (table === 'tabs') tabTotalWrites.push(Number((patch as Row).total))
            for (const r of found) Object.assign(r, patch)
          }
          const project = (r: Row) =>
            !columns || columns.includes('*')
              ? { ...r }
              : Object.fromEntries(
                  columns.split(',').map((c) => [c.trim(), r[c.trim()] ?? null]),
                )
          return Promise.resolve(resolve({ data: found.map(project), error: null }))
        },
      }
      return api
    },
  }
}

import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

function seed(orders: Row[]) {
  mockOrders = orders.map((o) => ({
    restaurant_id: RESTAURANT_ID,
    tab_id: TAB_ID,
    ...o,
  }))
  tabTotalWrites = []
}

async function payTheOrder() {
  return markOrderPaidConfirmed(makeClient() as never, {
    orderId: ORDER_ID,
    restaurantId: RESTAURANT_ID,
    reference: 'REF-1',
    amount: 20,
    source: 'test',
  })
}

const tabTotal = () => tabTotalWrites[tabTotalWrites.length - 1]

describe('#104 fifth site — markOrderPaidConfirmed tab total', () => {
  it('excludes a cancelled order from the recomputed tab total', async () => {
    seed([
      { id: 'o-cancelled', total: 30, payment_status: 'cancelled' },
      { id: ORDER_ID, total: 20, payment_status: 'pending' },
    ])

    const result = await payTheOrder()

    expect(result).toMatchObject({ claimed: true, tabId: TAB_ID })
    expect(tabTotal()).toBe(0)
  })

  it("excludes a 'Paid' row whose casing byte-exact SQL would miss", async () => {
    seed([
      { id: 'o-oddcase', total: 40, payment_status: 'Paid' },
      { id: ORDER_ID, total: 20, payment_status: 'pending' },
    ])

    await payTheOrder()

    expect(tabTotal()).toBe(0)
  })

  // CONTROL — must hold before and after. Without it, "cancelled no longer counts" is
  // satisfied by a total that counts nothing at all.
  it.each([...OWES_MONEY_PAYMENT_STATUSES])(
    'still counts a %s sibling as money owed',
    async (siblingStatus) => {
      seed([
        { id: 'o-owing', total: 30, payment_status: siblingStatus },
        { id: ORDER_ID, total: 20, payment_status: 'pending' },
      ])

      await payTheOrder()

      expect(tabTotal()).toBe(30)
    },
  )

  // CONTROL — the order just paid must drop out of the total, not be double-counted.
  it('does not count the order it just marked paid', async () => {
    seed([{ id: ORDER_ID, total: 20, payment_status: 'pending' }])

    await payTheOrder()

    expect(tabTotal()).toBe(0)
  })
})
