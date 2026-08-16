/**
 * #232 — the staff report's "unresolved orders" count.
 *
 * BOUND TO THE RULE, NOT TO A COPY OF IT. The rule is `owesMoney` in
 * `lib/payments/payment-integrity.ts`; these assertions import it and the status set beside it,
 * so if a status is ever added to or removed from `OWES_MONEY_PAYMENT_STATUSES` this file follows
 * rather than pinning a stale list. A test that restated the set would stay green against a
 * report that had drifted from it (#205's lesson).
 *
 * THE ASSERTION THAT CARRIES THE FILE is `a cancelled PAYMENT is not money anyone owes`. That is
 * the divergence between the old inline predicate and the shared one, and it is the sixth
 * appearance of the same question — `mark-order-paid-confirmed.ts` records #104 as the fifth.
 *
 * AND A SOURCE SCAN, because the obvious residual turned out to be worse than assumed.
 *
 * The first version of this file said "that the report CALLS `owesMoney` is covered by reading
 * and by tsc". **It is not covered by tsc.** A two-sided probe reverted the call site to the
 * hand-rolled `o.status !== 'cancelled' && o.payment_status !== 'paid'` and measured what
 * noticed:
 *
 *     jest  -> 10 passed   (this file binds to the RULE, so it cannot see the call site)
 *     tsc   -> exit 0      (the inline version is perfectly valid TypeScript)
 *
 * Nothing caught it. That is #205's lesson arriving from the other direction: binding a test to
 * the shipped rule protects the rule and says nothing about whether anyone uses it. So the last
 * describe block scans the shipped source — the same shape as
 * `__tests__/customer-screens-do-not-log-credentials.test.ts`, and for the same reason: it is the
 * only thing that can see this.
 *
 * Exercising `getReportData` directly was the alternative and was rejected: it builds a Supabase
 * client and issues several queries, so the test would mostly be asserting against its own mock.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  OWES_MONEY_PAYMENT_STATUSES,
  owesMoney,
} from '@/lib/payments/payment-integrity'

/** The predicate the report used to carry, reproduced here ONLY to contrast the two. */
function oldInlinePredicate(order: { status?: string; payment_status?: string }): boolean {
  return order.status !== 'cancelled' && order.payment_status !== 'paid'
}

describe('unresolved orders count what is still owed', () => {
  it.each([...OWES_MONEY_PAYMENT_STATUSES])('counts %s', (status) => {
    expect(owesMoney(status)).toBe(true)
  })

  it('does not count a paid order', () => {
    expect(owesMoney('paid')).toBe(false)
  })

  it('a cancelled PAYMENT is not money anyone owes — the whole divergence', () => {
    // `payment_status = 'cancelled'` is a value this codebase writes, and it is deliberately
    // absent from OWES_MONEY_PAYMENT_STATUSES. The old inline predicate counted it, because
    // "not paid" is also true of a cancelled payment.
    expect(owesMoney('cancelled')).toBe(false)
    expect(oldInlinePredicate({ status: 'ready', payment_status: 'cancelled' })).toBe(true)
  })

  it('the two predicates disagree on exactly that case and agree elsewhere', () => {
    const cases = [
      { status: 'ready', payment_status: 'paid', agree: true },
      { status: 'ready', payment_status: 'pending', agree: true },
      { status: 'ready', payment_status: 'cash_pending', agree: true },
      { status: 'ready', payment_status: 'failed', agree: true },
      { status: 'ready', payment_status: 'terminal_pending', agree: true },
      // The divergence.
      { status: 'ready', payment_status: 'cancelled', agree: false },
    ]
    for (const c of cases) {
      const same = oldInlinePredicate(c) === owesMoney(c.payment_status)
      expect({ status: c.payment_status, same }).toEqual({ status: c.payment_status, same: c.agree })
    }
  })

  it('refuses an unrecognised status rather than counting it', () => {
    // An allowlist, so a status added later is excluded until somebody decides it owes money.
    // The old predicate would have counted it by default.
    expect(owesMoney('some_status_added_later')).toBe(false)
    expect(oldInlinePredicate({ status: 'ready', payment_status: 'some_status_added_later' })).toBe(
      true
    )
  })

  it('treats a null or absent payment_status as not owed', () => {
    expect(owesMoney(null)).toBe(false)
    expect(owesMoney(undefined)).toBe(false)
  })
})

describe('the report actually USES the rule — the half no other check can see', () => {
  const SOURCE = readFileSync(
    join(process.cwd(), 'lib', 'reports', 'get-report-data.ts'),
    'utf8'
  )

  it('finds the file, so a rename cannot turn this into a silent no-op', () => {
    expect(SOURCE.length).toBeGreaterThan(1000)
    expect(SOURCE).toContain('unresolvedOrders')
  })

  it('imports owesMoney', () => {
    expect(SOURCE).toMatch(/import\s*\{\s*owesMoney\s*\}\s*from\s*'@\/lib\/payments\/payment-integrity'/)
  })

  it('does not hand-roll "not paid" anywhere in the file', () => {
    // The exact expression the probe reintroduced, and the family it belongs to. Comments are
    // stripped first so the docblock quoting the old predicate does not fail its own test.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/payment_status\s*!==\s*'paid'/)
    expect(code).not.toMatch(/\.neq\(\s*'payment_status'\s*,\s*'paid'\s*\)/)
  })

  it('computes unresolvedOrders through owesMoney', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const line = code.split('\n').find((l) => l.includes('unresolvedOrders ='))
    expect(line).toBeDefined()
    expect(line).toContain('owesMoney')
  })
})
