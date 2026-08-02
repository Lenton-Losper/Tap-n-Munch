/**
 * @jest-environment jsdom
 *
 * fetchOrdersForTab must query with EVERY session id the customer app holds.
 *
 * Orders are submitted with the tab-context id (`tab_session_id`, sessionStorage), while the
 * Tab and Receipt pages call this with the lib/session.ts id (`flashtap_session_v1`,
 * localStorage). Sending only the latter matches nothing, so a customer who has just ordered
 * sees an empty tab. These tests pin the query the page actually issues.
 */
import { fetchOrdersForTab } from '@/lib/tab-session'
import { TAB_SESSION_ID_KEY, LEGACY_TAB_SESSION_ID_KEY } from '@/lib/tab-storage'

// tab-session imports the browser Supabase client at module load; it is unused on this path.
jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))

const RESTAURANT = 'rest-1'
const TAB_ID = 'tab-abc'
const PAGE_SESSION = 'sess_11111111-2222-3333-4444-555555555555' // lib/session.ts namespace
const SUBMIT_SESSION = 'session_1785436537786_hkyljcsq9tn'       // tab-context namespace

let fetchMock: jest.Mock

/** The session_id values sent on the most recent by-session request. */
function sentSessionIds(): string[] {
  const url = String(fetchMock.mock.calls.at(-1)?.[0] ?? '')
  return new URLSearchParams(url.split('?')[1] ?? '').getAll('session_id')
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ orders: [], count: 0 }),
  }))
  ;(globalThis as any).fetch = fetchMock
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('fetchOrdersForTab', () => {
  it('sends the tab-context session id alongside the one the page passes', async () => {
    sessionStorage.setItem(TAB_SESSION_ID_KEY, SUBMIT_SESSION)

    await fetchOrdersForTab(TAB_ID, RESTAURANT, PAGE_SESSION)

    const sent = sentSessionIds()
    expect(sent).toContain(SUBMIT_SESSION) // the id orders are actually submitted with
    expect(sent).toContain(PAGE_SESSION)
  })

  it('still finds orders when the page has no id of its own', async () => {
    // The Tab page can load before lib/session.ts has minted anything.
    sessionStorage.setItem(TAB_SESSION_ID_KEY, SUBMIT_SESSION)

    await fetchOrdersForTab(TAB_ID, RESTAURANT, null)

    expect(fetchMock).toHaveBeenCalled()
    expect(sentSessionIds()).toEqual([SUBMIT_SESSION])
  })

  it('honours the legacy tab session key', async () => {
    sessionStorage.setItem(LEGACY_TAB_SESSION_ID_KEY, SUBMIT_SESSION)

    await fetchOrdersForTab(TAB_ID, RESTAURANT, PAGE_SESSION)

    expect(sentSessionIds()).toContain(SUBMIT_SESSION)
  })

  it('does not mint a session id, which would query for orders that cannot exist', async () => {
    await fetchOrdersForTab(TAB_ID, RESTAURANT, PAGE_SESSION)

    expect(sessionStorage.getItem(TAB_SESSION_ID_KEY)).toBeNull()
    expect(sentSessionIds()).toEqual([PAGE_SESSION])
  })

  it('sends no duplicates when both namespaces hold the same value', async () => {
    sessionStorage.setItem(TAB_SESSION_ID_KEY, PAGE_SESSION)

    await fetchOrdersForTab(TAB_ID, RESTAURANT, PAGE_SESSION)

    expect(sentSessionIds()).toEqual([PAGE_SESSION])
  })

  it('stays fail-closed when no session id is available at all', async () => {
    const rows = await fetchOrdersForTab(TAB_ID, RESTAURANT, null)

    // A tab UUID alone must never dump a tab, so no request should go out.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('scopes the query to the tab', async () => {
    sessionStorage.setItem(TAB_SESSION_ID_KEY, SUBMIT_SESSION)

    await fetchOrdersForTab(TAB_ID, RESTAURANT, PAGE_SESSION)

    const url = String(fetchMock.mock.calls.at(-1)?.[0] ?? '')
    const params = new URLSearchParams(url.split('?')[1] ?? '')
    expect(params.get('tabId')).toBe(TAB_ID)
    expect(params.get('restaurantId')).toBe(RESTAURANT)
  })
})
