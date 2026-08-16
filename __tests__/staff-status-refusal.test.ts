/**
 * Binds to lib/orders/staff-status-refusal.ts (#275).
 *
 * THE ASSERTIONS THAT CARRY THIS FILE are the negative ones: the message must not contain the
 * database identifiers, and it must not contain a word the dashboard does not use. That is the
 * defect — `Invalid transition: pending → preparing` showed a staff member two internal status
 * values and an arrow, and "pending" is not what the dashboard calls that state anywhere else
 * (its badge reads **New**).
 *
 * Everything else here is ordinary coverage of a copy function.
 */
import {
  staffStatusLabel,
  staffStatusRefusal,
  staffUnknownStatusRefusal,
} from '@/lib/orders/staff-status-refusal'

/** Raw values that must never reach a staff member's screen through a refusal. */
const INTERNAL_IDENTIFIERS = ['pending', 'ready_for_terminal', '→', 'Invalid transition']

describe('the refusal does not leak the transition table', () => {
  it('never shows the raw identifiers for the case the issue is about', () => {
    const { message } = staffStatusRefusal('pending', 'preparing')
    for (const token of INTERNAL_IDENTIFIERS) {
      expect(message).not.toContain(token)
    }
  })

  it('never shows an arrow or the words "Invalid transition" for ANY refusal', () => {
    const pairs: Array<[string, string]> = [
      ['pending', 'preparing'],
      ['pending', 'ready'],
      ['ready', 'preparing'],
      ['completed', 'preparing'],
      ['cancelled', 'accepted'],
      ['ready_for_terminal', 'preparing'],
      ['', 'preparing'],
    ]
    for (const [from, to] of pairs) {
      const { message } = staffStatusRefusal(from, to)
      expect(message).not.toContain('→')
      expect(message).not.toContain('Invalid transition')
    }
  })

  it("uses the dashboard's own word for a status, not the database's", () => {
    // The dashboard badge for `pending` reads "New". Showing "pending" makes staff translate.
    expect(staffStatusLabel('pending')).toBe('New')
    expect(staffStatusLabel('ready_for_terminal')).toBe('Ready for terminal')
  })

  it('falls back to the raw value for an unknown status rather than inventing a label', () => {
    expect(staffStatusLabel('some_future_status')).toBe('some_future_status')
  })
})

describe('every refusal tells the staff member what to DO', () => {
  it('names accepting as the next step when the order has not been accepted', () => {
    const { code, message } = staffStatusRefusal('pending', 'preparing')
    expect(code).toBe('NOT_ACCEPTED_YET')
    expect(message.toLowerCase()).toContain('accept')
  })

  it('covers both reasons an order can be sitting unaccepted', () => {
    // It may be brand new, or it may have come BACK after a customer edit raised the total.
    // The route does not know which, so the message must not assert either.
    const { message } = staffStatusRefusal('pending', 'preparing')
    expect(message.toLowerCase()).toContain('changed it')
  })

  it('tells them to refresh when the order has simply moved on', () => {
    const { code, message } = staffStatusRefusal('ready', 'preparing')
    expect(code).toBe('ORDER_MOVED_ON')
    expect(message.toLowerCase()).toContain('refresh')
  })

  it.each(['completed', 'cancelled'])('says a %s order cannot be changed at all', (from) => {
    const { code, message } = staffStatusRefusal(from, 'preparing')
    expect(code).toBe('ORDER_FINISHED')
    expect(message.toLowerCase()).toContain(from)
  })
})

describe('an unrecognised target status is a different kind of refusal', () => {
  it('has its own code, so a client bug is not read as a workflow problem', () => {
    const { code, message } = staffUnknownStatusRefusal('teleported')
    expect(code).toBe('UNKNOWN_STATUS')
    expect(message).toContain('teleported')
  })
})

describe('a CODE travels with every refusal', () => {
  it('is stable and machine-readable, so nothing has to match on the sentence', () => {
    // #273's lesson: two verification scripts once substring-matched a refusal's prose, so
    // rewording it silently changed what they asserted while both kept passing.
    const codes = [
      staffStatusRefusal('pending', 'preparing').code,
      staffStatusRefusal('ready', 'preparing').code,
      staffStatusRefusal('completed', 'preparing').code,
      staffUnknownStatusRefusal('x').code,
    ]
    expect(new Set(codes).size).toBe(4)
    for (const c of codes) expect(c).toMatch(/^[A-Z_]+$/)
  })
})
