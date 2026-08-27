/**
 * Staff-picker behaviour for cash attribution (#148).
 *
 * THIS SUITE USED TO TEST ITSELF. Every one of its eight assertions ran against local copies —
 * `openPicker`, `showsSkipOnly` and `canConfirm`, each commented "Mirrors ... in
 * TableDetailScreen" — and the file imported NOTHING. Breaking `openPinPrompt` outright could not
 * have failed it, because it never touched the screen. It proved only that the copy worked.
 *
 * The rules now live in lib/cashAttributionPicker and the screen calls them, so these assertions
 * are about the app. Verified by mutation rather than by assertion: see the commit for the three
 * screen-level breakages this now catches and previously did not.
 *
 * THE RULE THAT MATTERS OPERATIONALLY: attribution is optional, so nothing about the staff list may
 * ever make cash untakeable. An empty list and a failed fetch must both leave Skip reachable —
 * that is the real state at Riviera, Mingle and FNB ChowNow today, where nobody has a PIN.
 */
import {
  AuthorizedUser,
  CASH_ATTRIBUTION_PIN_LENGTH,
  canConfirmPin,
  preselectFor,
  showsSkipOnly,
} from '../cashAttributionPicker';

const JANE: AuthorizedUser = {user_id: 'u1', name: 'Jane Doe'};
const JOHN: AuthorizedUser = {user_id: 'u2', name: 'John Roe'};

/**
 * What openPinPrompt does with a list, using the real rule. The fetch itself is the screen's
 * business; what is pinned here is the decision it makes about the result.
 */
function stateFor(users: AuthorizedUser[]): {
  users: AuthorizedUser[];
  selected: AuthorizedUser | null;
} {
  return {users, selected: preselectFor(users)};
}

describe('cash attribution staff picker', () => {
  it('offers the skip path when no staff have a PIN', () => {
    expect(showsSkipOnly([])).toBe(true);
    expect(preselectFor([])).toBeNull();
  });

  it('offers the skip path when the list fails to load', () => {
    // openPinPrompt's catch sets staffList to [] (not null), so the same branch renders and cash
    // stays takeable. A null there would fall through to the list branch and render nothing.
    expect(showsSkipOnly([])).toBe(true);
    // And before the fetch resolves staffList is null — the screen shows a spinner, but the rule
    // must still not claim a usable list exists.
    expect(showsSkipOnly(null)).toBe(true);
  });

  it('does not offer skip-only once somebody is eligible', () => {
    // The other side: without this, a rule hardcoded to `true` would satisfy the two above and
    // the picker would never appear for anyone.
    expect(showsSkipOnly([JANE])).toBe(false);
    expect(showsSkipOnly([JANE, JOHN])).toBe(false);
  });

  it('pre-selects when exactly one staff member is eligible', () => {
    const s = stateFor([JANE]);
    expect(s.selected).toEqual(JANE);
    expect(canConfirmPin(s.selected, '1234', false)).toBe(true);
  });

  it('requires an explicit choice when several are eligible', () => {
    // Picking on someone's behalf would attribute cash to a person who never touched it.
    const s = stateFor([JANE, JOHN]);
    expect(s.selected).toBeNull();
    expect(canConfirmPin(s.selected, '1234', false)).toBe(false);
    expect(canConfirmPin(JOHN, '1234', false)).toBe(true);
  });

  it('will not confirm without a complete PIN', () => {
    for (const pin of ['', '1', '123', '12345']) {
      expect(canConfirmPin(JANE, pin, false)).toBe(false);
    }
    expect(canConfirmPin(JANE, '1234', false)).toBe(true);
  });

  it('will not confirm while a verification is in flight', () => {
    // Without the busy term a second tap starts a second authorize call for one settlement.
    expect(canConfirmPin(JANE, '1234', true)).toBe(false);
  });

  it('will not confirm with nobody selected, whatever the PIN', () => {
    expect(canConfirmPin(null, '1234', false)).toBe(false);
  });

  it('agrees with the PIN length the keypad enforces', () => {
    // The screen's maxLength and this rule must not drift apart; a 4 here and a 6 there would
    // leave Confirm permanently disabled.
    expect(CASH_ATTRIBUTION_PIN_LENGTH).toBe(4);
    expect(
      canConfirmPin(JANE, '9'.repeat(CASH_ATTRIBUTION_PIN_LENGTH), false),
    ).toBe(true);
  });

  it('never exposes the user_id as something to type', () => {
    // #148 itself: the uuid is carried by the app and selected by tapping a name. Staff were
    // being asked to type all 36 characters of it on a POS touchscreen mid-service.
    const jane = {user_id: 'e65059f8-0727-4c9f-a268-4661eadb0325', name: 'Jane'};
    const s = stateFor([jane]);
    expect(s.selected?.user_id).toBe(jane.user_id);
    expect(s.selected?.name).toBe('Jane');
  });
});
