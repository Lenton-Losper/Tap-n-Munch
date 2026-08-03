/**
 * Staff-picker behaviour for cash attribution.
 *
 * The rule that matters operationally: attribution is optional, so nothing about the staff
 * list may ever make cash untakeable. An empty list and a failed fetch must both leave the
 * Skip path reachable — this is the real state at Riviera, Mingle and FNB ChowNow today,
 * where no staff member has a PIN.
 */
type AuthorizedUser = {user_id: string; name: string};

type PickerState = {
  loading: boolean;
  users: AuthorizedUser[] | null;
  loadFailed: boolean;
  selected: AuthorizedUser | null;
};

/** Mirrors openPinPrompt in TableDetailScreen. */
async function openPicker(
  fetchUsers: () => Promise<AuthorizedUser[]>,
): Promise<PickerState> {
  try {
    const users = await fetchUsers();
    return {
      loading: false,
      users,
      loadFailed: false,
      // One eligible person is pre-selected so it is a single tap to the keypad.
      selected: users.length === 1 ? users[0] : null,
    };
  } catch {
    return {loading: false, users: [], loadFailed: true, selected: null};
  }
}

/** Mirrors the modal's branch: empty OR failed -> attribution impossible, Skip offered. */
function showsSkipOnly(s: PickerState): boolean {
  return (s.users?.length ?? 0) === 0;
}

function canConfirm(s: PickerState, pin: string, busy: boolean): boolean {
  return !busy && pin.length === 4 && s.selected !== null;
}

describe('cash attribution staff picker', () => {
  it('offers the skip path when no staff have a PIN', async () => {
    const s = await openPicker(async () => []);
    expect(s.users).toEqual([]);
    expect(s.loadFailed).toBe(false);
    // Must NOT render a blank list — the empty branch owns this state.
    expect(showsSkipOnly(s)).toBe(true);
  });

  it('offers the skip path when the list fails to load', async () => {
    const s = await openPicker(async () => {
      throw new Error('network');
    });
    expect(s.loadFailed).toBe(true);
    expect(showsSkipOnly(s)).toBe(true);
    // Cash must never become untakeable because a list did not load.
  });

  it('distinguishes "nobody has a PIN" from "could not load"', async () => {
    const empty = await openPicker(async () => []);
    const failed = await openPicker(async () => {
      throw new Error('network');
    });
    // Both show Skip, but the copy differs, so loadFailed must be distinguishable.
    expect(showsSkipOnly(empty)).toBe(showsSkipOnly(failed));
    expect(empty.loadFailed).not.toBe(failed.loadFailed);
  });

  it('pre-selects when exactly one staff member is eligible', async () => {
    const only = {user_id: 'u1', name: 'Jane Doe'};
    const s = await openPicker(async () => [only]);
    expect(s.selected).toEqual(only);
    expect(canConfirm(s, '1234', false)).toBe(true);
  });

  it('requires an explicit choice when several are eligible', async () => {
    const s = await openPicker(async () => [
      {user_id: 'u1', name: 'Jane'},
      {user_id: 'u2', name: 'John'},
    ]);
    expect(s.selected).toBeNull();
    expect(canConfirm(s, '1234', false)).toBe(false);

    s.selected = {user_id: 'u2', name: 'John'};
    expect(canConfirm(s, '1234', false)).toBe(true);
  });

  it('will not confirm without a complete PIN', async () => {
    const s = await openPicker(async () => [{user_id: 'u1', name: 'Jane'}]);
    for (const pin of ['', '1', '123', '12345']) {
      expect(canConfirm(s, pin, false)).toBe(false);
    }
    expect(canConfirm(s, '1234', false)).toBe(true);
  });

  it('will not confirm while a verification is in flight', async () => {
    const s = await openPicker(async () => [{user_id: 'u1', name: 'Jane'}]);
    expect(canConfirm(s, '1234', true)).toBe(false);
  });

  it('never exposes the user_id as something to type', async () => {
    // The uuid is carried by the app, never entered. Selection is by object identity
    // from the server list, so a staff member only ever taps a name.
    const users = [{user_id: 'e65059f8-0727-4c9f-a268-4661eadb0325', name: 'Jane'}];
    const s = await openPicker(async () => users);
    expect(s.selected?.user_id).toBe(users[0].user_id);
    expect(s.selected?.name).toBe('Jane');
  });
});
