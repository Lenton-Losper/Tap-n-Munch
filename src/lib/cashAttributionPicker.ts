/**
 * The decisions behind the cash-attribution staff picker (#148).
 *
 * WHY THIS MODULE EXISTS AT ALL. `cashAttributionPicker.test.ts` was written against it before it
 * was written — the suite defined its own local `openPicker`, `showsSkipOnly` and `canConfirm`,
 * each commented "Mirrors ... in TableDetailScreen", and imported nothing. Eight tests, zero
 * imports: it exercised its own copy of the rules and could not observe the screen at all. Breaking
 * `openPinPrompt` outright would not have failed one of them. These are now the real functions the
 * screen calls, so the suite tests the app instead of itself.
 *
 * Kept free of React and react-native so the rules can be asserted directly.
 *
 * THE RULE THAT MATTERS OPERATIONALLY: attribution is OPTIONAL, so nothing here may ever make cash
 * untakeable. An empty list and a failed fetch must both leave the Skip path reachable — and that
 * is the live state at Riviera, Mingle and FNB ChowNow today, where no staff member has a PIN.
 */

/** One person who may be attributed a cash settlement. Shape of /api/terminal/authorized-users. */
export interface AuthorizedUser {
  user_id: string;
  name: string;
}

/** The PIN is a fixed-length keypad entry; the confirm button is gated on a complete one. */
export const CASH_ATTRIBUTION_PIN_LENGTH = 4;

/**
 * Who to pre-select when the list arrives.
 *
 * Exactly one eligible person is the common case in a small restaurant, and pre-selecting makes it
 * a single tap to the keypad. With several, the choice must be explicit — picking someone on their
 * behalf would attribute cash to a person who never touched it.
 */
export function preselectFor(users: AuthorizedUser[]): AuthorizedUser | null {
  return users.length === 1 ? users[0] : null;
}

/**
 * Whether the modal must offer ONLY the Skip path, because attribution is impossible.
 *
 * True for an empty list and for a failed load alike. The two are distinguished in the COPY (see
 * the screen's `staffLoadFailed` branch) but not in what is offered: cash must never become
 * untakeable because a list did not load.
 */
export function showsSkipOnly(users: AuthorizedUser[] | null): boolean {
  return (users?.length ?? 0) === 0;
}

/**
 * Whether Confirm may be pressed: somebody chosen, a complete PIN, and no verification in flight.
 *
 * The `busy` term is not cosmetic — without it a second tap starts a second authorize call for the
 * same settlement.
 */
export function canConfirmPin(
  selected: AuthorizedUser | null,
  pin: string,
  busy: boolean,
): boolean {
  return !busy && pin.length === CASH_ATTRIBUTION_PIN_LENGTH && selected !== null;
}
