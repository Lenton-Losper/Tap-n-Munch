/**
 * #120 — an un-accepted round is invisible to the terminal, and settle can miss part of the bill.
 *
 * THE SCENARIO: a customer orders at 20:15, staff have not pressed Accept, staff settle and close
 * at 20:20. The round is not on the bill, is never marked paid, and re-inflates a settled and
 * closed tab the moment somebody finally accepts it.
 *
 * WHY IT WAS INVISIBLE: `unpaid_total` and `can_close` are computed from `orders`, and a
 * waiting-review round is not a row in `orders` at all. This is NOT the same defect as the
 * cancelled-order hardening at terminal/tables/route.ts:140 — a cancelled order is a row with the
 * wrong status; this is no row.
 *
 * FAILS WITHOUT THE FIX: `lib/tabs/pending-order-requests.ts` does not exist at `ceea943`, and
 * neither close route consults `order_requests` — verified by grep, zero occurrences across all
 * three routes.
 *
 * THE LOAD-BEARING CASES, so a future reader can check this suite still bites:
 *   - a FAILED read blocks exactly as hard as a real pending count. Delete `unknown` from
 *     `blocksSettlement` and those go red. That is #104's defect in the other direction: an
 *     errored read that yields an empty array reads as "nothing outstanding".
 *   - a request carrying NO tab_id, only table_id, is still counted. `order_requests.tab_id` is
 *     nullable, and matching on tab alone misses the round nothing else can see.
 *   - the close route REFUSES rather than warning, and `closeTableSession` is never reached.
 */
import { POST as CLOSE } from '@/app/api/terminal/tables/[tableId]/close/route'
import {
  blocksSettlement,
  fetchPendingOrderRequests,
  pendingOrderRequestValue,
  summarisePendingForTab,
  LIVE_REQUEST_STATUSES,
} from '@/lib/tabs/pending-order-requests'

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE_ID = '77777777-2222-3333-4444-555555555555'
const TAB_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_TAB_ID = '22222222-2222-3333-4444-555555555555'

type Row = Record<string, unknown>

let tabRows: Row[]
let tabError: unknown
let requestRowsByColumn: { tab_id: Row[]; table_id: Row[] }
let requestError: unknown
let closeCalled: boolean
/** Every filter the request queries applied, so an unscoped read cannot pass unnoticed. */
let requestFilters: Array<Array<[string, unknown]>>

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from(table: string) {
      if (table === 'tabs') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: async () => ({ data: tabRows, error: tabError }),
        }
        return chain
      }
      if (table === 'order_requests') {
        const applied: Array<[string, unknown]> = []
        let column: 'tab_id' | 'table_id' = 'tab_id'
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq(c: string, v: unknown) {
            applied.push([c, v])
            return chain
          },
          in(c: string, v: unknown) {
            applied.push([c, v])
            if (c === 'tab_id' || c === 'table_id') {
              column = c
              return chain
            }
            // The status filter is last; resolve here.
            requestFilters.push(applied)
            return Promise.resolve({
              data: requestError ? null : requestRowsByColumn[column],
              error: requestError,
            })
          },
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_ID,
    terminalId: 'terminal-1',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/session-manager', () => ({
  closeTableSession: async () => {
    closeCalled = true
    return { success: true }
  },
}))

function pendingRequest(overrides: Row = {}): Row {
  return {
    id: 'req-1',
    tab_id: TAB_ID,
    table_id: TABLE_ID,
    table_number: 4,
    status: 'waiting_review',
    total: 90,
    total_reviewed: null,
    placed_at: '2026-08-25T20:15:00.000Z',
    ...overrides,
  }
}

function closeReq() {
  return new Request(`http://localhost/api/terminal/tables/${TABLE_ID}/close`, { method: 'POST' })
}
const closeParams = { params: Promise.resolve({ tableId: TABLE_ID }) }

beforeEach(() => {
  tabRows = [{ id: TAB_ID }]
  tabError = null
  requestRowsByColumn = { tab_id: [], table_id: [] }
  requestError = null
  requestFilters = []
  closeCalled = false
})

describe('#120 the vocabulary', () => {
  it('counts "accepting" as undecided, not as accepted', () => {
    // The transient claim Accept takes before the orders row exists. It is the WORST case for
    // #120: an accept is in flight, so a row is about to appear on a tab being settled right now.
    expect([...LIVE_REQUEST_STATUSES]).toEqual(['waiting_review', 'accepting'])
  })

  it('is the same list lib/guest-orders/queries.ts filters on — one home, not two', () => {
    // Imported by that module rather than duplicated; if this file ever stops being its source,
    // the two surfaces can disagree about what is live.
    const source = require('fs').readFileSync('lib/guest-orders/queries.ts', 'utf8')
    expect(source).toContain("from '@/lib/tabs/pending-order-requests'")
    expect(source).not.toMatch(/const LIVE_REQUEST_STATUSES\s*=/)
  })
})

describe('#120 what a pending request is worth', () => {
  it('prefers total_reviewed — staff edits during review recalculate into it', () => {
    expect(pendingOrderRequestValue({ total: 90, total_reviewed: 65 })).toBe(65)
  })

  it('falls back to the submitted total when review has not touched it', () => {
    expect(pendingOrderRequestValue({ total: 90, total_reviewed: null })).toBe(90)
  })

  it('treats a reviewed total of 0 as a real 0, not as absent', () => {
    // `total_reviewed ?? total` and `total_reviewed || total` differ here, and one of them
    // reports 90 for a round staff reduced to nothing.
    expect(pendingOrderRequestValue({ total: 90, total_reviewed: 0 })).toBe(0)
  })
})

describe('#120 fail closed', () => {
  it('an UNKNOWN count blocks exactly as hard as a real one', () => {
    expect(blocksSettlement({ count: 0, value: 0, unknown: true })).toBe(true)
    expect(blocksSettlement({ count: 2, value: 50, unknown: false })).toBe(true)
    expect(blocksSettlement({ count: 0, value: 0, unknown: false })).toBe(false)
  })

  it('a failed read reports unknown, never a zero count', () => {
    // The distinction the whole issue turns on: `count === 0` is what a caller naively reads, and
    // on a failed read it is TRUE while meaning nothing. `unknown` is what carries the truth.
    const summary = summarisePendingForTab({ rows: [], failed: true }, TAB_ID, TABLE_ID)
    expect(summary.count).toBe(0)
    expect(summary.unknown).toBe(true)
    expect(blocksSettlement(summary)).toBe(true)
  })

  it('refuses to answer at all without a restaurant scope', async () => {
    const lookup = await fetchPendingOrderRequests({} as never, {
      restaurantId: '',
      tabIds: [TAB_ID],
    })
    expect(lookup).toEqual({ rows: [], failed: true })
  })

  it('a genuinely empty question is a real zero, not an unknown', async () => {
    const lookup = await fetchPendingOrderRequests({} as never, {
      restaurantId: RESTAURANT_ID,
      tabIds: [],
      tableIds: [],
    })
    expect(lookup).toEqual({ rows: [], failed: false })
  })
})

describe('#120 which requests belong to this tab', () => {
  const lookup = (rows: Row[]) => ({ rows: rows as never, failed: false })

  it('claims a request carrying THIS tab id', () => {
    const s = summarisePendingForTab(lookup([pendingRequest()]), TAB_ID, TABLE_ID)
    expect(s.count).toBe(1)
    expect(s.value).toBe(90)
  })

  it('claims a request with NO tab id that names this table — the nullable-tab_id case', () => {
    const s = summarisePendingForTab(
      lookup([pendingRequest({ tab_id: null })]),
      TAB_ID,
      TABLE_ID,
    )
    expect(s.count).toBe(1)
  })

  it('NEVER claims a request that names a DIFFERENT tab, whatever table it sits at', () => {
    const s = summarisePendingForTab(
      lookup([pendingRequest({ tab_id: OTHER_TAB_ID })]),
      TAB_ID,
      TABLE_ID,
    )
    expect(s.count).toBe(0)
  })

  it('collects tab-less orphans when asked with a null tab id', () => {
    const s = summarisePendingForTab(lookup([pendingRequest({ tab_id: null })]), null, TABLE_ID)
    expect(s.count).toBe(1)
  })
})

describe('#120 POST /api/terminal/tables/[tableId]/close', () => {
  it('closes normally when nothing is waiting for review', async () => {
    const res = await CLOSE(closeReq(), closeParams)
    expect(res.status).toBe(200)
    expect(closeCalled).toBe(true)
  })

  it('REFUSES 409 when a round is waiting for review, and never closes the table', async () => {
    requestRowsByColumn.tab_id = [pendingRequest()]
    const res = await CLOSE(closeReq(), closeParams)
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      code: 'PENDING_ORDER_REQUESTS',
      pending_request_count: 1,
      pending_requests_value: 90,
    })
    // The point of the whole issue: close_table_session settles every tab and evicts every
    // session. It must not have run.
    expect(closeCalled).toBe(false)
  })

  it('REFUSES a tab-less request that only names the table', async () => {
    requestRowsByColumn.table_id = [pendingRequest({ id: 'req-orphan', tab_id: null })]
    const res = await CLOSE(closeReq(), closeParams)
    expect(res.status).toBe(409)
    expect(closeCalled).toBe(false)
  })

  it('REFUSES 503 when the order_requests read fails — an unreadable table is not an empty one', async () => {
    requestError = { message: 'connection reset' }
    const res = await CLOSE(closeReq(), closeParams)
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ code: 'PENDING_REQUEST_CHECK_FAILED' })
    expect(closeCalled).toBe(false)
  })

  it('REFUSES 503 when the tabs read fails — it cannot know which tabs to check', async () => {
    tabError = { message: 'connection reset' }
    const res = await CLOSE(closeReq(), closeParams)
    expect(res.status).toBe(503)
    expect(closeCalled).toBe(false)
  })

  it('scopes the request read by restaurant AND status — never an unbounded read', async () => {
    requestRowsByColumn.tab_id = [pendingRequest()]
    await CLOSE(closeReq(), closeParams)
    const flat = requestFilters.flat()
    expect(flat).toContainEqual(['restaurant_id', RESTAURANT_ID])
    expect(flat).toContainEqual(['status', ['waiting_review', 'accepting']])
  })

  it('does not decide anything — the refusal names the requests instead', async () => {
    requestRowsByColumn.tab_id = [pendingRequest()]
    const res = await CLOSE(closeReq(), closeParams)
    await expect(res.json()).resolves.toMatchObject({
      pending_request_ids: ['req-1'],
    })
    // Accept / decline is a human decision on the dashboard. This route refuses; it never resolves.
    expect(closeCalled).toBe(false)
  })
})
