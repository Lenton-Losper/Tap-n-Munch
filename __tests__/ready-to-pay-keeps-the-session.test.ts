/**
 * ASKING TO PAY MUST NOT END THE SESSION. RULED 2026-08-26.
 *
 * A customer tapped Settle, chose a payment method, and was on `/session-ended` about five seconds
 * later with their cart cleared, having paid nothing. Their own button did it:
 *
 *   POST /api/tabs/[tabId]/ready-to-pay   ->  tabs.status = 'ready_to_pay'
 *   validateSessionToken                  ->  status !== 'open'  ->  invalid
 *   the /tab poll (5s) via fetchWithSession -> 410 -> handleSessionExpired -> /session-ended
 *
 * THE TEST THAT MATTERS is 'a ready_to_pay tab keeps the session'. Everything else exists so it
 * cannot be satisfied trivially: a validator that returned `valid` for everything would pass it and
 * would let a phone read the next party's bill after the table was closed.
 *
 * BOTH DIRECTIONS ARE ASSERTED because only one of them was ever wrong, and the fix moves the line
 * rather than removing it. A settled tab must still evict.
 */
import { isActiveTabStatus, isTabSessionEndedStatus, ACTIVE_TAB_STATUSES, TAB_SESSION_ENDED_STATUSES } from '@/lib/tab-status'

const SESSION = {
  id: 's-1',
  tab_id: 'tab-1',
  table_id: 'table-1',
  restaurant_id: 'rest-1',
  session_version: 4,
  active: true,
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  restaurant_tables: { current_session_version: 4 },
}

let tabStatus = 'open'
let sessionOverride: Record<string, unknown> | null = null

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: sessionOverride ?? { ...SESSION, tabs: { status: tabStatus } },
            error: null,
          }),
        }),
      }),
    }),
  }),
}))

// Imported after the mock so the module picks it up.
import { validateSessionToken } from '@/lib/session-token'

beforeEach(() => {
  tabStatus = 'open'
  sessionOverride = null
})

describe('the ruling — requested is not paid, and paid is not closed', () => {
  it('a READY_TO_PAY tab KEEPS the session', async () => {
    // The defect, in one assertion. This returned { valid: false } and evicted the customer who
    // had just asked to pay.
    tabStatus = 'ready_to_pay'
    const result = await validateSessionToken('tok')
    expect(result.valid).toBe(true)
    expect(result.tabId).toBe('tab-1')
  })

  it('an OPEN tab keeps the session', async () => {
    tabStatus = 'open'
    expect((await validateSessionToken('tok')).valid).toBe(true)
  })

  it.each([...TAB_SESSION_ENDED_STATUSES])(
    'a %s tab STILL evicts — the line moved, it was not removed',
    async (status) => {
      tabStatus = status
      const result = await validateSessionToken('tok')
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/no longer open/i)
    },
  )

  it('an UNRECOGNISED status does not evict', async () => {
    /*
     * Deliberate, and the same call `cashReadyToPayRefusal` already makes: an unrecognised status
     * is not evidence the party has left, and the failure mode being fixed here IS eviction. A
     * status this vocabulary has not heard of must not throw a customer out mid-meal.
     */
    tabStatus = 'awaiting_something_new'
    expect((await validateSessionToken('tok')).valid).toBe(true)
  })
})

describe('the other validity conditions are untouched', () => {
  it('a revoked session is still invalid', async () => {
    sessionOverride = { ...SESSION, active: false, tabs: { status: 'ready_to_pay' } }
    const r = await validateSessionToken('tok')
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/revoked/i)
  })

  it('an expired session is still invalid', async () => {
    sessionOverride = {
      ...SESSION,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      tabs: { status: 'ready_to_pay' },
    }
    const r = await validateSessionToken('tok')
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/expired/i)
  })

  it('a session version mismatch still evicts — the table was reset under them', async () => {
    // THE CROSS-TENANT GUARD. This is what stops a phone reading the next party's figures after
    // close_table_session bumps the table version, and it is NOT what the status check was doing.
    sessionOverride = {
      ...SESSION,
      session_version: 3,
      restaurant_tables: { current_session_version: 4 },
      tabs: { status: 'ready_to_pay' },
    }
    const r = await validateSessionToken('tok')
    expect(r.valid).toBe(false)
    expect(r.reason).toMatch(/version mismatch/i)
  })

  it('a missing tab still evicts', async () => {
    sessionOverride = { ...SESSION, tabs: null }
    expect((await validateSessionToken('tok')).valid).toBe(false)
  })
})

describe('the vocabulary is one definition, not two', () => {
  it('ready_to_pay is an ACTIVE status and has been all along', () => {
    // The fix was to USE this, not to invent it. validateSessionToken hard-coded a narrower rule.
    expect(ACTIVE_TAB_STATUSES).toContain('ready_to_pay')
    expect(isActiveTabStatus('ready_to_pay')).toBe(true)
  })

  it('active and ended are disjoint', () => {
    for (const s of ACTIVE_TAB_STATUSES) expect(isTabSessionEndedStatus(s)).toBe(false)
    for (const s of TAB_SESSION_ENDED_STATUSES) expect(isActiveTabStatus(s)).toBe(false)
  })

  it('lib/tab-session re-exports the SAME function, so the two cannot drift', async () => {
    const viaSession = await import('@/lib/tab-status')
    expect(viaSession.isTabSessionEndedStatus).toBe(isTabSessionEndedStatus)
  })

  it('is case-insensitive, because statuses arrive from the database', () => {
    expect(isTabSessionEndedStatus('SETTLED')).toBe(true)
    expect(isTabSessionEndedStatus('Ready_To_Pay')).toBe(false)
  })
})
