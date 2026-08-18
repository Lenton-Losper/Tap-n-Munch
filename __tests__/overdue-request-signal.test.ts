/**
 * THE STAFF SIGNAL FOR AN UNANSWERED REQUEST.
 *
 * Production had a submission open for 477 hours. Every writer of `order_requests.status` is a
 * human action and the every-2-minutes cron sweeps `orders` only, so nothing aged it, nothing
 * ranked it, and nothing told anyone — it sat wherever the fetch order put it, indistinguishable
 * from one placed thirty seconds ago.
 *
 * These pin the predicate and the threshold. Where the queue actually RANKS is a render decision
 * and is asserted in a browser (tests/e2e/dashboard-overdue-requests.spec.ts).
 */
import {
  STALE_REQUEST_THRESHOLD_MS,
  isRequestOverdue,
  requestWaitingMinutes,
} from '@/lib/orders/customer-status'

const MIN = 60 * 1000
const NOW = Date.parse('2026-08-18T12:00:00.000Z')
const agoMin = (m: number) => new Date(NOW - m * MIN).toISOString()

describe('the overdue threshold', () => {
  it('is fifteen minutes, in one named constant', () => {
    // Named so it moves on evidence rather than being hunted through render code. The reasoning
    // and the (thin) measurement behind the number live on the constant itself.
    expect(STALE_REQUEST_THRESHOLD_MS).toBe(15 * MIN)
  })

  it('does not flag a request that is merely recent', () => {
    // The other side of the pair, and the one that matters most: a signal that fires on ordinary
    // service is ignored, which is the failure this exists to fix.
    expect(isRequestOverdue(agoMin(0), NOW)).toBe(false)
    expect(isRequestOverdue(agoMin(1), NOW)).toBe(false)
    expect(isRequestOverdue(agoMin(14), NOW)).toBe(false)
  })

  it('flags one that has passed the threshold', () => {
    expect(isRequestOverdue(agoMin(16), NOW)).toBe(true)
    expect(isRequestOverdue(agoMin(60 * 477), NOW)).toBe(true) // the production row
  })

  it('does not flip exactly ON the boundary — strictly greater, so it cannot flicker', () => {
    expect(isRequestOverdue(new Date(NOW - STALE_REQUEST_THRESHOLD_MS).toISOString(), NOW)).toBe(
      false,
    )
  })

  /**
   * The opposite default from `isStaleDeadOrder`, deliberately. There, treating undated debris as
   * old CLEARS a dead row off a customer's screen. Here, treating an undated row as overdue would
   * put a false alarm at the top of a working queue — and a staff signal that cries wolf is
   * ignored.
   */
  it('treats an unreadable timestamp as NOT overdue, rather than crying wolf', () => {
    expect(isRequestOverdue(null, NOW)).toBe(false)
    expect(isRequestOverdue(undefined, NOW)).toBe(false)
    expect(isRequestOverdue('not a date', NOW)).toBe(false)
    expect(isRequestOverdue('', NOW)).toBe(false)
  })

  it('reads a Date as well as an ISO string, because rows arrive both ways', () => {
    expect(isRequestOverdue(new Date(NOW - 20 * MIN), NOW)).toBe(true)
  })

  it('never reports a negative wait for a clock-skewed future timestamp', () => {
    expect(requestWaitingMinutes(new Date(NOW + 5 * MIN), NOW)).toBe(0)
    expect(isRequestOverdue(new Date(NOW + 5 * MIN), NOW)).toBe(false)
  })

  it('states the wait in whole minutes, which is what the staff label shows', () => {
    expect(requestWaitingMinutes(agoMin(41), NOW)).toBe(41)
    expect(requestWaitingMinutes(agoMin(0.4), NOW)).toBe(0)
    expect(requestWaitingMinutes('nonsense', NOW)).toBe(0)
  })
})

describe('the ranking rule', () => {
  /**
   * The dashboard sorts with this comparator. Pinned here as well as in the browser because the
   * ORDER is the fix — "sorted to the top, not merely marked" — and a browser test can only assert
   * the two or three rows it seeds.
   */
  const rank = (rows: Array<{ id: string; placed_at: string }>) =>
    [...rows]
      .sort((a, b) => {
        const ao = isRequestOverdue(a.placed_at, NOW)
        const bo = isRequestOverdue(b.placed_at, NOW)
        if (ao !== bo) return ao ? -1 : 1
        const d = Date.parse(a.placed_at) - Date.parse(b.placed_at)
        return d !== 0 ? d : a.id.localeCompare(b.id)
      })
      .map((r) => r.id)

  it('puts every overdue request above every fresh one', () => {
    expect(
      rank([
        { id: 'fresh-a', placed_at: agoMin(2) },
        { id: 'overdue-old', placed_at: agoMin(300) },
        { id: 'fresh-b', placed_at: agoMin(9) },
        { id: 'overdue-new', placed_at: agoMin(20) },
      ]),
      // fresh-b (9 min) outranks fresh-a (2 min): worst-first applies WITHIN the fresh group too,
      // not just across the boundary. My first expectation had these the other way round.
    ).toEqual(['overdue-old', 'overdue-new', 'fresh-b', 'fresh-a'])
  })

  it('reads worst-first WITHIN each group, not newest-first', () => {
    expect(
      rank([
        { id: 'waited-20', placed_at: agoMin(20) },
        { id: 'waited-90', placed_at: agoMin(90) },
      ]),
    ).toEqual(['waited-90', 'waited-20'])
  })

  it('breaks ties on id, so the queue cannot flicker between renders', () => {
    const same = agoMin(40)
    expect(rank([{ id: 'b', placed_at: same }, { id: 'a', placed_at: same }])).toEqual(['a', 'b'])
  })
})
