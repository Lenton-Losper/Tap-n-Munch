/**
 * THE PAYMENT STATE MACHINE — every legal transition, and every illegal one.
 *
 * `orders.payment_status` had nine writable values, no database constraint, and no central rule
 * about which may follow which. Each route decided for itself, by passing its own
 * `fromPaymentStatuses` array or inlining `.in('payment_status', [...])`, and three production
 * rows sit in states no rule permits.
 *
 * ==================================================================================================
 * THE TWO HALVES, AND WHY THEY ARE SEPARATE
 * ==================================================================================================
 *
 * THE ALPHABET is enforced by the database: `orders_payment_status_enumerated` admits exactly the
 * nine values and nothing else. Proved against a real Postgres in
 * supabase/tests/settlement-rpc.test.sql (`constraint/payment_status_enumerated`, and its
 * companion `constraint/all_nine_statuses_accepted`, which proves the constraint is not too
 * tight either).
 *
 * THE GRAMMAR is enforced in code, and this file is where it is asserted. A CHECK constraint sees
 * one row at a time and cannot see the value a row is moving FROM, so "paid may not become
 * pending" is not expressible as one -- it would need a trigger on `orders`, which fires on every
 * write in the system and is a larger change than this sprint should make.
 *
 * `settle_order_payment()` enforces the one transition that matters most (anything -> paid) inside
 * the settlement transaction, and refuses the whole settlement rather than skipping an order.
 * That is asserted in the SQL suite as `illegal/*`, and mutation M7 removes the guard and requires
 * those to go red.
 */
import {
  PAYMENT_STATUSES,
  canTransition,
  isPaymentStatus,
  normalizePaymentStatus,
  orderContradictions,
  transitionsInto,
  type PaymentStatus,
} from '@/lib/payments/payment-state-machine'
import {
  CLAIMABLE_PAYMENT_STATUSES,
  OWES_MONEY_PAYMENT_STATUSES,
  CASH_SETTLEABLE_PAYMENT_STATUSES,
} from '@/lib/payments/payment-integrity'

describe('the alphabet', () => {
  it('is the nine values the writers can produce', () => {
    expect([...PAYMENT_STATUSES].sort()).toEqual(
      [
        'amount_mismatch_hold',
        'cancelled',
        'cash_pending',
        'failed',
        'paid',
        'pending',
        'terminal_pending',
        'unpaid',
        'verification_unavailable_hold',
      ].sort(),
    )
  })

  it('contains every value the existing status sets use', () => {
    /**
     * THE BINDING CHECK. `payment-integrity.ts` owns four overlapping status sets that predate
     * this module, and if the enumeration here ever drifts from them the DATABASE CONSTRAINT would
     * start refusing a value a route legitimately writes -- a 500 at the till.
     *
     * Derived from the real sets rather than restated, so adding a status there and forgetting it
     * here fails at build time instead of at a terminal.
     */
    const used = new Set<string>([
      ...CLAIMABLE_PAYMENT_STATUSES,
      ...OWES_MONEY_PAYMENT_STATUSES,
      ...CASH_SETTLEABLE_PAYMENT_STATUSES,
      'paid',
      'cancelled',
    ])
    const missing = [...used].filter((s) => !isPaymentStatus(s))
    expect(missing).toEqual([])
  })

  it('normalises the way every reader in payment-integrity already does', () => {
    expect(normalizePaymentStatus(' Paid ')).toBe('paid')
    expect(normalizePaymentStatus('PAID')).toBe('paid')
    expect(isPaymentStatus(' Paid ')).toBe(true)
    expect(isPaymentStatus('refunded')).toBe(false)
    expect(isPaymentStatus(null)).toBe(false)
  })
})

describe('legal transitions', () => {
  it.each([
    ['pending', 'terminal_pending'],
    ['pending', 'paid'],
    ['pending', 'cancelled'],
    ['pending', 'cash_pending'],
    ['pending', 'failed'],
    ['pending', 'amount_mismatch_hold'],
    ['pending', 'verification_unavailable_hold'],
    ['terminal_pending', 'paid'],
    ['terminal_pending', 'cash_pending'],
    ['terminal_pending', 'failed'],
    ['terminal_pending', 'pending'],
    ['cash_pending', 'paid'],
    ['cash_pending', 'cancelled'],
    ['failed', 'paid'],
    ['failed', 'cash_pending'],
    ['amount_mismatch_hold', 'paid'],
    ['amount_mismatch_hold', 'cancelled'],
    ['verification_unavailable_hold', 'paid'],
    ['unpaid', 'paid'],
  ])('%s -> %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toEqual({ ok: true, reason: 'legal' })
  })

  it('cancelled -> paid is allowed, because the E04111 recovery is real', () => {
    /**
     * An order auto-cancelled on "the gateway has no record" is un-cancelled when the gateway
     * later proves it WAS charged. `claimableStatusesForRecovery` has performed this edge since
     * before this module existed; it is not new here.
     *
     * WHETHER a given cancelled order qualifies is a different question, decided by
     * lib/payments/e04111-recovery.ts against the cancellation reason, and enforced by
     * settle_order_payment through its explicit allow-list.
     */
    expect(canTransition('cancelled', 'paid').ok).toBe(true)
  })

  it('a re-write of the same value is a no-op, not a transition', () => {
    for (const s of PAYMENT_STATUSES) {
      expect(canTransition(s, s)).toEqual({ ok: true, reason: 'same_state' })
    }
  })
})

describe('illegal transitions', () => {
  it('PAID IS TERMINAL — a paid order cannot become unpaid', () => {
    /**
     * Financial invariant 8. A reversal is a REFUND: an append to the ledger, not a walk-back of
     * this column. So there is no edge out of `paid` at all, and every one of these refusing is
     * the point rather than an omission.
     */
    for (const to of PAYMENT_STATUSES) {
      if (to === 'paid') continue
      expect(canTransition('paid', to)).toEqual({ ok: false, reason: 'illegal' })
    }
    expect(transitionsInto('paid')).not.toContain('paid')
  })

  it.each([
    ['paid', 'pending'],
    ['paid', 'cancelled'],
    ['paid', 'failed'],
    ['paid', 'terminal_pending'],
    ['cancelled', 'pending'],
    ['cancelled', 'terminal_pending'],
    ['cancelled', 'cash_pending'],
    ['cancelled', 'failed'],
  ])('%s -> %s is refused', (from, to) => {
    expect(canTransition(from, to).ok).toBe(false)
  })

  it('FAILS CLOSED on a value it does not recognise', () => {
    // An unreadable current status is not permission to overwrite it.
    expect(canTransition('refunded', 'paid')).toEqual({ ok: false, reason: 'unknown_from' })
    expect(canTransition('paid', 'refunded')).toEqual({ ok: false, reason: 'unknown_to' })
    expect(canTransition(null, 'paid').ok).toBe(false)
    expect(canTransition('pending', undefined).ok).toBe(false)
    expect(canTransition('', '').ok).toBe(false)
  })
})

describe('transitionsInto', () => {
  it('names every status a claim to paid may come from', () => {
    const into = transitionsInto('paid')
    // Everything that owes money, plus the two holds and the E04111 recovery.
    for (const s of CLAIMABLE_PAYMENT_STATUSES) expect(into).toContain(s)
    expect(into).toContain('terminal_pending')
    expect(into).toContain('amount_mismatch_hold')
    expect(into).toContain('verification_unavailable_hold')
    expect(into).toContain('cancelled')
  })

  it('is exactly the set settle_order_payment accepts', () => {
    /**
     * BINDS THE TWO IMPLEMENTATIONS. The plpgsql function carries its own literal list, because a
     * SQL function cannot import a TypeScript module. Two copies of one rule is the shape that
     * drifts, so this asserts they are the same set by reading the migration.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('path')
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260919090000_settle_order_payment_atomic.sql'),
      'utf8',
    )
    /**
     * Bounded at the IN-list's own closing paren, not by a character count. A fixed-width window
     * ran past it into the `jsonb_build_object` that follows and picked up its KEYS as statuses --
     * a test that failed for a reason that had nothing to do with the thing under test.
     */
    const start = sql.indexOf('IF v_status NOT IN (')
    expect(start).toBeGreaterThan(-1)
    const end = sql.indexOf(') THEN', start)
    expect(end).toBeGreaterThan(start)
    const block = sql.slice(start, end)
    const listed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])

    // The SQL list is what may transition INTO paid, which is exactly transitionsInto('paid').
    expect(listed.sort()).toEqual(transitionsInto('paid').sort())
  })
})

describe('the companion invariants — what must agree with payment_status', () => {
  it('names the production contradictions rather than correcting them', () => {
    // 3 rows on production: paid with a cancelled lifecycle status.
    expect(orderContradictions({ payment_status: 'paid', status: 'cancelled' })).toEqual([
      'paid_but_status_not_completed',
    ])
    // 1 row: #377, cancelled_at set 324ms before paid_at.
    expect(
      orderContradictions({
        payment_status: 'paid',
        status: 'completed',
        cancelled_at: '2026-07-23T12:35:11.457Z',
      }),
    ).toEqual(['paid_but_cancelled_at_set'])
  })

  it('reports BOTH when a row manages both', () => {
    expect(
      orderContradictions({
        payment_status: 'paid',
        status: 'cancelled',
        cancelled_at: '2026-07-23T12:35:11.457Z',
      }),
    ).toEqual(['paid_but_status_not_completed', 'paid_but_cancelled_at_set'])
  })

  it('is silent on a consistent row', () => {
    expect(
      orderContradictions({ payment_status: 'paid', status: 'completed', cancelled_at: null }),
    ).toEqual([])
    expect(
      orderContradictions({ payment_status: 'pending', status: 'pending', cancelled_at: null }),
    ).toEqual([])
    expect(
      orderContradictions({ payment_status: 'cancelled', status: 'cancelled' }),
    ).toEqual([])
  })

  it('is a REPORT and not a gate — it refuses nothing', () => {
    // The rows that trip it are historical. A gate would hide them by refusing to read them.
    const contradictory = { payment_status: 'paid', status: 'cancelled' }
    expect(() => orderContradictions(contradictory)).not.toThrow()
    expect(orderContradictions(contradictory).length).toBeGreaterThan(0)
  })
})

describe('the database constraint admits exactly the nine', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path')

  it('the migration lists every declared status and no others', () => {
    /**
     * The other half of the drift check above. If a status is added to PAYMENT_STATUSES and not to
     * the constraint, the database starts refusing a value a route legitimately writes -- a 500 at
     * the till, and the hardest kind to attribute.
     */
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260919091000_payment_integrity_constraints.sql'),
      'utf8',
    )
    const block = sql.slice(
      sql.indexOf('payment_status IS NULL OR payment_status IN ('),
      sql.indexOf('orders_payment_status_enumerated', sql.indexOf('ALTER TABLE public.orders VALIDATE')),
    )
    const listed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as PaymentStatus)

    expect([...new Set(listed)].sort()).toEqual([...PAYMENT_STATUSES].sort())
  })
})
