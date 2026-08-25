/**
 * #344 — which order a recovered card payment may settle.
 *
 * THESE ASSERT THE NEW BEHAVIOUR, not the old. Before this guard, both call sites in payment.ts
 * returned a recovered orphan as the result for WHICHEVER order was on screen. If the app died
 * after the reader's callback for order A and staff then started a payment on order B, B was
 * reported paid carrying A's voucher and A stayed unpaid — and the server's amount gate could not
 * catch it, because the amount sent was B's own total and matched B exactly.
 *
 * The ruling, 2026-08-25:
 *   1. names THIS order      -> apply
 *   2. names a DIFFERENT one -> hold (never discard)
 *   3. names no order at all -> hold. UNKNOWN IS NOT PERMISSION.
 *
 * Case 3 is the one with history. The comment this guard replaces read "Prefer applying orphan
 * only when it matches this order (or order id unknown)", and that parenthesis is the defect
 * itself — so it gets its own assertions rather than being folded into case 2.
 */
import {decideOrphanDisposition} from '../orphanPaymentGuard';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('case 1 — the orphan names this order', () => {
  it('applies it', () => {
    expect(decideOrphanDisposition(A, A)).toEqual({disposition: 'apply'});
  });

  it('applies it regardless of surrounding whitespace or case', () => {
    expect(decideOrphanDisposition(`  ${A.toUpperCase()} `, A)).toEqual({
      disposition: 'apply',
    });
  });
});

describe('case 2 — the orphan names a different order', () => {
  it('HOLDS rather than applying', () => {
    // The #344 scenario exactly: an orphan from order A surfacing during a charge for order B.
    expect(decideOrphanDisposition(A, B)).toEqual({
      disposition: 'hold',
      reason: 'different_order',
    });
  });

  it('holds when the orphan covers only PART of what is being charged', () => {
    // Applying a single-order payment to a two-order settle would settle the wrong amount —
    // the same class of defect this guard exists to prevent. Equality, never overlap.
    expect(decideOrphanDisposition(A, `${A},${B}`)).toEqual({
      disposition: 'hold',
      reason: 'different_order',
    });
  });

  it('holds when the orphan covers MORE than what is being charged', () => {
    expect(decideOrphanDisposition(`${A},${B}`, A)).toEqual({
      disposition: 'hold',
      reason: 'different_order',
    });
  });

  it('holds when the sets overlap but are not equal', () => {
    expect(decideOrphanDisposition(`${A},${B}`, `${A},${C}`)).toEqual({
      disposition: 'hold',
      reason: 'different_order',
    });
  });
});

describe('case 3 — the orphan names no order. UNKNOWN IS NOT PERMISSION.', () => {
  it('holds on an empty string, which is what native actually sends', () => {
    // PaymentModule.kt writes `json.optString("orderId", "")`, so the absent case arrives as ''
    // rather than undefined. Testing only for undefined would miss every real occurrence.
    expect(decideOrphanDisposition('', A)).toEqual({
      disposition: 'hold',
      reason: 'unknown_order',
    });
  });

  it('holds on undefined', () => {
    expect(decideOrphanDisposition(undefined, A)).toEqual({
      disposition: 'hold',
      reason: 'unknown_order',
    });
  });

  it('holds on null', () => {
    expect(decideOrphanDisposition(null, A)).toEqual({
      disposition: 'hold',
      reason: 'unknown_order',
    });
  });

  it('holds on whitespace and on bare commas', () => {
    expect(decideOrphanDisposition('   ', A).disposition).toBe('hold');
    expect(decideOrphanDisposition(' , , ', A).disposition).toBe('hold');
  });

  it('holds when the ORDER ON SCREEN is the unknown one', () => {
    // Same rule from the other direction: nothing to compare against is not permission either.
    expect(decideOrphanDisposition(A, '')).toEqual({
      disposition: 'hold',
      reason: 'unknown_order',
    });
  });
});

describe('a tab settle is not a false mismatch', () => {
  it('applies when the same orders are listed in a different order', () => {
    // The id list is derived at the moment of the charge, so a retry can legitimately reorder it.
    // Plain string equality would hold a payment that genuinely belongs to this charge.
    expect(decideOrphanDisposition(`${B},${A}`, `${A},${B}`)).toEqual({
      disposition: 'apply',
    });
  });

  it('applies despite differing spacing', () => {
    expect(decideOrphanDisposition(`${A}, ${B}`, `${A},${B}`)).toEqual({
      disposition: 'apply',
    });
  });

  it('still holds for a genuinely different settle', () => {
    expect(decideOrphanDisposition(`${A},${B}`, `${B},${C}`).disposition).toBe(
      'hold',
    );
  });
});

describe('the guard is not vacuously safe', () => {
  it('does not simply hold everything', () => {
    // A predicate that always held would satisfy every assertion above about safety and make the
    // recovery mechanism useless — the case the whole thing was built for must still work.
    expect(decideOrphanDisposition(A, A).disposition).toBe('apply');
  });

  it('distinguishes the two hold reasons, which drive different operator copy', () => {
    const different = decideOrphanDisposition(A, B);
    const unknown = decideOrphanDisposition('', B);
    expect(different).not.toEqual(unknown);
    expect(
      different.disposition === 'hold' ? different.reason : null,
    ).toBe('different_order');
    expect(unknown.disposition === 'hold' ? unknown.reason : null).toBe(
      'unknown_order',
    );
  });
});
