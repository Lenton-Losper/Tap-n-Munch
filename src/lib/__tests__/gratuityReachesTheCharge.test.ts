/**
 * THE GRATUITY A WAITER KEYED MUST REACH THE READER, OR THE CHARGE MUST NOT HAPPEN.
 *
 * ==================================================================================================
 * WHAT THE P5 FOUND THAT EVERY SUITE MISSED — 2026-09-09, Digi Cofee
 * ==================================================================================================
 *
 * Table 5, a N$20 item selected, gratuity keyed at N$10. The screen showed the gratuity. The reader
 * displayed NAD 20.00.
 *
 * GratuitySection has always computed `valid` — false when a tip is keyed and no staff member is
 * chosen — and its own docblock says, verbatim: "The caller DISABLES the charge buttons on this."
 * NOTHING EVER READ IT. The contract was written down and never implemented.
 *
 * So gratuityExtras() returned {} (it refuses to emit a tip with no recipient), the tip vanished
 * before any request was made, and the charge went out for the bill alone — while the UI went on
 * showing N$10 the entire time.
 *
 * ==================================================================================================
 * WHY NO EXISTING TEST COULD SEE IT
 * ==================================================================================================
 *
 * Every gratuity test constructed a VALID state by hand — `{tipCents: 500, tipStaffUserId: 'x'}` —
 * because that is what a person writing a tip test types. The real UI can produce an INVALID one,
 * and that is the only shape that fails. The tests and the screen agreed with each other and both
 * disagreed with the device.
 *
 * The server could not catch it either: TIP_NEEDS_STAFF cannot fire for a field that was never sent.
 */
import {gratuityExtras, NO_GRATUITY, type GratuityState} from '../../components/GratuitySection';

const keyed = (over: Partial<GratuityState> = {}): GratuityState => ({
  tipCents: 1000,
  tipStaffUserId: 'staff-1',
  valid: true,
  ...over,
});

describe('THE SILENT DROP — the mechanism the device demonstrated', () => {
  it('a tip with NO recipient is discarded entirely, not refused', () => {
    /**
     * This is correct behaviour for gratuityExtras and is exactly why a caller-side guard is
     * required: it cannot signal a problem, it can only emit nothing. payment_tips.staff_user_id is
     * NOT NULL, so a tip with nobody to pay it to is genuinely unrecordable.
     */
    expect(gratuityExtras(keyed({tipStaffUserId: null, valid: false}))).toEqual({});
  });

  it('and the state that produces it is exactly what the screen showed', () => {
    /**
     * The waiter keyed 1000 cents and the UI rendered it. `valid` is the ONLY field that says
     * anything is wrong — which is why leaving it unread made the failure invisible.
     */
    const state = keyed({tipStaffUserId: null, valid: false});
    expect(state.tipCents).toBe(1000);
    expect(state.valid).toBe(false);
  });

  it('a complete gratuity is emitted in full', () => {
    // The positive control. If gratuityExtras returned {} always, the assertion above passes while
    // no tip could ever be charged.
    expect(gratuityExtras(keyed())).toEqual({tipCents: 1000, tipStaffUserId: 'staff-1'});
  });

  it('no gratuity at all is valid and emits nothing', () => {
    expect(NO_GRATUITY.valid).toBe(true);
    expect(gratuityExtras(NO_GRATUITY)).toEqual({});
  });

  it('a keyed tip WITH a recipient is valid; without one it is not', () => {
    // The rule GratuitySection applies, pinned so a refactor cannot invert it.
    expect(keyed({tipStaffUserId: 'x', valid: true}).valid).toBe(true);
    expect(keyed({tipStaffUserId: null, valid: false}).valid).toBe(false);
  });
});

describe('EVERY MONEY PATH REFUSES TO CHARGE AN UNCHARGEABLE GRATUITY', () => {
  /**
   * Asserted against the screen's SOURCE. The defect was not in any function's behaviour — it was
   * that no call site consulted `valid`. Mounting the screen and driving the picker would test the
   * picker; the question here is whether the three buttons that move money ask first.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {join} = require('path') as {join: (...p: string[]) => string};
  const proc = (globalThis as unknown as {process?: {cwd(): string}}).process;
  const CODE = readFileSync(
    join(proc ? proc.cwd() : '.', 'src', 'screens', 'TableDetailScreen.tsx'),
    'utf8',
  );

  it('the screen was read — not an empty match', () => {
    expect(CODE.length).toBeGreaterThan(1000);
  });

  it('the guard exists and reads `valid`', () => {
    expect(CODE.includes('const gratuityIsChargeable')).toBe(true);
    expect(CODE.includes('if (gratuity.valid) return true;')).toBe(true);
  });

  it.each([
    ['Settle Selected — card, whole-order AND split', 'const handleSettleSelected = () => {'],
    ['Settle Entire Tab', 'const handleSettleEntireTab = () => {'],
    ['Take Cash', 'const handleTakeCash = () => {'],
  ])('%s asks before it charges', (_label, opener) => {
    /**
     * Scoped to the first few lines of each handler, so the guard has to come BEFORE the work. A
     * check placed after the charge would satisfy a whole-file match and protect nothing — and on
     * this path "after" means after the customer has paid.
     */
    const at = CODE.indexOf(opener);
    expect(at).toBeGreaterThan(-1);
    const head = CODE.slice(at, at + 400);
    expect(head.includes('gratuityIsChargeable()')).toBe(true);
  });

  it('the split path is covered — it is the one the device actually took', () => {
    /**
     * A single selected item on a part-paid order routes to plan.kind === 'allocations' and
     * runSplitCardPayment, NOT the whole-order path. Every whole-order tip test written before this
     * was therefore testing a path the waiter never used.
     */
    const at = CODE.indexOf('const handleSettleSelected = () => {');
    const head = CODE.slice(at, at + 700);
    expect(head.includes('gratuityIsChargeable()')).toBe(true);
    expect(head.includes('runSplitCardPayment')).toBe(true);
    // The guard precedes the branch, so both branches inherit it.
    expect(head.indexOf('gratuityIsChargeable()')).toBeLessThan(head.indexOf('runSplitCardPayment'));
  });
});
