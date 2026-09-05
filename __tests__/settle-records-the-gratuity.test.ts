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
  it('refuses with TIP_NEEDS_ATTRIBUTION', () => {
    expect(CODE).toMatch(/TIP_NEEDS_ATTRIBUTION/)
    expect(CODE).toMatch(/tipCents > 0 && !attributedStaffUserId/)
  })

  it('that refusal comes BEFORE the orders are claimed', () => {
    // The CLAIM is what flips orders to paid — anchored on `claimQuery`, not on the first
    // `from('orders')`, which is the earlier read of the tab's orders and proves nothing.
    // Refusing after the claim would leave a settled tab and a 400: the worst of both.
    expect(at('TIP_NEEDS_ATTRIBUTION')).toBeLessThan(at('claimQuery'))
  })

  it('a settlement with no tip is unaffected by that gate', () => {
    // The condition is guarded on tipCents > 0, so a tipless cash settle still needs no PIN.
    expect(CODE).toMatch(/if \(tipCents > 0 && !attributedStaffUserId\)/)
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

  it('the settler is the staff member the token identified', () => {
    expect(CODE).toMatch(/staffUserId: String\(attributedStaffUserId\)/)
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
