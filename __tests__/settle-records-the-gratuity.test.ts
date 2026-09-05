/**
 * THE SETTLE ROUTE'S GRATUITY WIRING.
 *
 * ============================================================================================
 * WHAT IS TESTED HERE, AND WHAT IS TESTED ELSEWHERE
 * ============================================================================================
 *
 * The gratuity LOGIC -- parsing, refusing, what gets written, never throwing, duplicates -- is
 * behavioural and lives in __tests__/tips-are-voluntary-and-outside-vat.test.ts against the real
 * `lib/payments/tips.ts`. It is mutation-verified twelve ways.
 *
 * What is left is the WIRING, and the wiring is entirely about ORDER: refuse before the money
 * moves, record after it has, and never let a tip near the amount check. Executing this route
 * under jest means standing up a mock for every Supabase chain in a 700-line settlement path;
 * the existing suites that execute a terminal route do it for much smaller ones. A harness that
 * large mostly asserts against itself, so these pin the order against the REAL SOURCE instead.
 *
 * That is a weaker test than execution and is stated rather than glossed: it would not catch a
 * runtime fault inside a correctly-ordered call. It does catch every reordering, and reordering
 * is the failure mode that costs a customer money.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(
  join(__dirname, '..', 'app', 'api', 'terminal', 'tabs', '[tabId]', 'settle', 'route.ts'),
  'utf8',
)

/** Executable source only: the prose below explains what must NOT happen, and says the words. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const at = (needle: string) => {
  const i = CODE.indexOf(needle)
  expect(i).toBeGreaterThan(-1)
  return i
}

describe('the gratuity never touches the amount check', () => {
  it('the amount compared against order totals is the BILL, with no tip added', () => {
    // amountsMatch(amount, expectedAmount) is a money control: it stops a terminal settling a tab
    // for the wrong figure. Folding a tip in would loosen it to "totals, or totals plus
    // something", which is not a check.
    expect(CODE).toMatch(/amountsMatch\(amount, expectedAmount\)/)
    expect(CODE).not.toMatch(/amountsMatch\([^)]*tip/i)
    expect(CODE).not.toMatch(/expectedAmount\s*\+\s*tip/i)
    expect(CODE).not.toMatch(/amount\s*\+\s*tip/i)
  })

  it('the payments row stores the bill, not the bill plus the tip', () => {
    // Bounded to the INSERT OBJECT ITSELF. A slice running to the audit log would swallow the
    // tip-recording block that legitimately sits between them, and match on that instead.
    const insert = CODE.slice(at("from('payments')"), at('if (paymentInsertError)'))
    expect(insert).toMatch(/amount: expectedAmount/)
    expect(insert).not.toMatch(/tip/i)
  })

  it('the gratuity is read as its own field, in cents', () => {
    expect(CODE).toMatch(/parseTipCents\(body\.tip_cents \?\? body\.tipCents\)/)
  })
})

describe('a tip with no named staff member is refused before the money moves', () => {
  it('refuses with TIP_NEEDS_STAFF when the picker sent nobody', () => {
    expect(CODE).toMatch(/TIP_NEEDS_STAFF/)
    expect(CODE).toMatch(/tipCents > 0 && !tipStaffUserId/)
  })

  it('checks the picked person actually works at this venue', () => {
    // Unverified is not unchecked: the FK to users(id) would accept another venue's staff.
    expect(CODE).toMatch(/TIP_STAFF_NOT_A_MEMBER/)
    expect(CODE).toMatch(/\.eq\('user_id', tipStaffUserId\)/)
    expect(CODE).toMatch(/\.eq\('restaurant_id', terminal\.restaurantId\)/)
  })

  it('that refusal comes BEFORE the orders are claimed', () => {
    // The CLAIM is what flips orders to paid — anchored on `claimQuery`, not on the first
    // `from('orders')`, which is the earlier read of the tab's orders and proves nothing.
    // Refusing after the claim would leave a settled tab and a 400: the worst of both.
    expect(at('TIP_NEEDS_STAFF')).toBeLessThan(at('claimQuery'))
  })

  it('a settlement with no tip is unaffected by that gate', () => {
    // Guarded on tipCents > 0, so a tipless settle is untouched — no picker, no PIN, no change.
    expect(CODE).toMatch(/if \(tipCents > 0 && !tipStaffUserId\)/)
  })

  it('an invalid tip is refused at parse time, before anything else', () => {
    expect(at('parseTipCents')).toBeLessThan(at("from('orders')"))
    expect(CODE).toMatch(/if \(!tipParse\.ok\)/)
  })
})

describe('the tip is recorded after the money, against the payment that carried it', () => {
  it('recordTip runs AFTER the payments insert', () => {
    expect(at("from('payments')")).toBeLessThan(at('recordTip('))
  })

  it('the payments insert returns its id, so the tip has something to point at', () => {
    const insert = CODE.slice(at("from('payments')"), at('recordTip('))
    expect(insert).toMatch(/\.select\('id'\)/)
  })

  it('no payment row means no tip row, rather than an invented parent', () => {
    expect(CODE).toMatch(/not_recorded_no_payment_row/)
    expect(CODE).toMatch(/if \(!paymentId\)/)
  })

  it('the tip method mirrors how the bill was settled', () => {
    expect(CODE).toMatch(/method: isCashSettlement \? 'cash' : 'card'/)
  })

  /**
   * THE TWO ATTRIBUTIONS MUST NOT MERGE.
   *
   * `attributedStaffUserId` is PIN-proved and is what the audit trail calls
   * `actor_attribution: 'staff_authorized'`. The tip's is a picker choice with nothing behind it.
   * Using the verified variable for the tip would be harmless; using the PICKER value for the
   * settlement attribution would silently downgrade every `staff_user_id` ever written from
   * "proved" to "asserted" — so they are kept apart and this asserts the separation in both
   * directions.
   */
  it('the tip uses the PICKER value, never the PIN-proved one', () => {
    expect(CODE).toMatch(/staffUserId: tipStaffUserId/)
    expect(CODE).not.toMatch(/staffUserId: String\(attributedStaffUserId\)/)
  })

  it('the settlement attribution is still the PIN-proved one, untouched by the picker', () => {
    /**
     * SCOPED TO THE AUDIT BLOCK. `staff_user_id: attributedStaffUserId` appears in the audit
     * metadata AND in the response, so a whole-file match is satisfied by either — mutation
     * testing caught exactly that: swapping the AUDIT one to the unverified picker value left the
     * response copy matching, and the suite stayed green while the durable record silently
     * downgraded from "who proved it" to "who was tapped". Third time this pattern has bitten.
     */
    const audit = CODE.slice(at("from('audit_logs')"), at('new_tab_total'))
    expect(audit).toMatch(/^\s*staff_user_id: attributedStaffUserId/m)
    // Line-anchored: `tip_staff_user_id: tipStaffUserId` legitimately sits in this same block and
    // CONTAINS `staff_user_id: tipStaffUserId` as a substring, so an unanchored negative match
    // fails on correct code.
    expect(audit).not.toMatch(/^\s*staff_user_id: tipStaffUserId/m)
    expect(audit).toMatch(/actor_attribution: attributedStaffUserId \? 'staff_authorized' : 'terminal_only'/)
  })

  it('the audit names the picker claim apart, and says it is unverified', () => {
    expect(CODE).toMatch(/tip_staff_user_id: tipStaffUserId/)
    expect(CODE).toMatch(/tip_attribution: 'picker_unverified'/)
  })
})

describe('a gratuity that was taken and not recorded is visible, never silent', () => {
  /**
   * SCOPED TO EACH BLOCK, because the outcome is written in TWO places and a whole-file match
   * cannot tell them apart.
   *
   * The first version asserted `tip_recorded: tipOutcome` appeared anywhere. Mutation testing
   * caught it: deleting the AUDIT entry entirely left the RESPONSE copy, the regex still matched,
   * and the suite stayed green while a gratuity taken and not recorded became invisible in the
   * only durable record. `new_tab_total` is response-only and sits between the two, so it is the
   * boundary.
   */
  const AUDIT = CODE.slice(at("from('audit_logs')"), at('new_tab_total'))
  const RESPONSE = CODE.slice(at('new_tab_total'))

  it('the AUDIT TRAIL carries the outcome, and only when a tip was keyed', () => {
    expect(AUDIT).toMatch(/tip_recorded: tipOutcome/)
    expect(AUDIT).toMatch(/tip_cents: tipCents/)
    // Guarded, so an absent key means "no tip" and never "a tip we lost".
    expect(AUDIT).toMatch(/\.\.\.\(tipCents > 0/)
  })

  it('the RESPONSE carries it too, so the terminal can reconcile', () => {
    expect(RESPONSE).toMatch(/tip_recorded: tipOutcome/)
    expect(RESPONSE).toMatch(/\.\.\.\(tipCents > 0/)
  })

  it('recording a gratuity never aborts a completed settlement', () => {
    // recordTip is awaited but its failure only logs — the customer has paid and the table must
    // turn. The never-throws contract itself is asserted in the tips suite.
    const after = CODE.slice(at('recordTip('))
    expect(after).not.toMatch(/throw /)
    expect(after).toMatch(/console\.error/)
  })
})

/**
 * THE SPLIT PATH. Same rules, a different ledger.
 *
 * `settle-allocations` writes `order_line_allocation_settlements`, not `payments`, and the two
 * are NOT interchangeable -- which is exactly why the tip has a nullable FK to each and a CHECK
 * requiring one. These pin that this path obeys the same ordering as the whole-tab route.
 */
describe('the split settle path records the gratuity too', () => {
  const ALLOC = readFileSync(
    join(__dirname, '..', 'app', 'api', 'terminal', 'tabs', '[tabId]', 'settle-allocations', 'route.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const allocAt = (needle: string) => {
    const i = ALLOC.indexOf(needle)
    expect(i).toBeGreaterThan(-1)
    return i
  }

  /**
   * ASSERT THE CONDITION, NOT THE MESSAGE INSIDE IT.
   *
   * These three tests first checked only that `TIP_NEEDS_ATTRIBUTION`,
   * `not_recorded_no_settlement_row` and `parseTipCents` appeared. Mutation testing caught all
   * three: replacing each guard's condition with `if (false)` leaves those strings sitting inside
   * the now-dead block, so every assertion still matched and the suite stayed green while the
   * guards did nothing. A marker proves a branch was written; only the condition proves it runs.
   */
  it('refuses an unattributed gratuity BEFORE the settle RPC runs', () => {
    expect(ALLOC).toMatch(/if \(tipCents > 0 && !tipStaffUserId\)/)
    expect(ALLOC).toMatch(/TIP_NEEDS_STAFF/)
    expect(allocAt('TIP_NEEDS_STAFF')).toBeLessThan(allocAt("rpc('settle_order_line_allocations'"))
  })

  it('checks the picked person works at this venue, before the RPC', () => {
    expect(ALLOC).toMatch(/TIP_STAFF_NOT_A_MEMBER/)
    expect(allocAt('TIP_STAFF_NOT_A_MEMBER')).toBeLessThan(allocAt("rpc('settle_order_line_allocations'"))
  })

  it('uses the PICKER value for the tip and leaves the ledger attribution PIN-proved', () => {
    expect(ALLOC).toMatch(/staffUserId: tipStaffUserId/)
    expect(ALLOC).toMatch(/p_staff_user_id: attributedStaffUserId/)
    expect(ALLOC).toMatch(/tip_attribution: 'picker_unverified'/)
  })

  it('parses the gratuity before anything settles, and acts on a bad value', () => {
    expect(allocAt('parseTipCents')).toBeLessThan(allocAt("rpc('settle_order_line_allocations'"))
    expect(ALLOC).toMatch(/if \(!tipParse\.ok\)/)
  })

  it('records the tip AFTER the RPC, against the allocation settlement', () => {
    expect(allocAt("rpc('settle_order_line_allocations'")).toBeLessThan(allocAt('recordTip('))
    expect(ALLOC).toMatch(/allocationSettlementId: settlementId/)
  })

  it('finds the settlement by THIS call payment_reference, not by guessing', () => {
    const block = ALLOC.slice(allocAt("from('order_line_allocation_settlements')"), allocAt('recordTip('))
    expect(block).toMatch(/\.eq\('payment_reference', paymentReference\)/)
    expect(block).toMatch(/\.eq\('restaurant_id', terminal\.restaurantId\)/)
  })

  it('reports a gratuity it could not attach, rather than dropping it silently', () => {
    // The condition, not just the message it produces — see the note above.
    expect(ALLOC).toMatch(/if \(settlementReadError \|\| !settlementId\)/)
    expect(ALLOC).toMatch(/not_recorded_no_settlement_row/)
    // The allocations ARE settled at that point; the customer has paid.
    const after = ALLOC.slice(allocAt('not_recorded_no_settlement_row'))
    expect(after).not.toMatch(/throw /)
  })

  it('carries the outcome in the audit trail and the response, guarded on a tip existing', () => {
    const audit = ALLOC.slice(allocAt("from('audit_logs')"), allocAt('new_tab_total'))
    expect(audit).toMatch(/tip_recorded: tipOutcome/)
    const response = ALLOC.slice(allocAt('new_tab_total'))
    expect(response).toMatch(/tip_recorded: tipOutcome/)
  })

  it('never folds the gratuity into the settled amount', () => {
    expect(ALLOC).not.toMatch(/appliedAmountCents\s*\+\s*tipCents/)
    expect(ALLOC).toMatch(/amount: fromCents\(appliedAmountCents\)/)
  })
})
