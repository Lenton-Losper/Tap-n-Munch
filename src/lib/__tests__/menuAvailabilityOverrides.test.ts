/**
 * The store the menu grid reads to correct a cache it fetched once and never refetches.
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING FOR A CALLER RATHER THAN FOR THEIR OWN SAKE:
 *
 * 1. NULL AND FALSE ARE DIFFERENT ANSWERS. Null means "this device has changed nothing about this
 *    item, use the fetched record"; false means "the server told this device the dish is hidden".
 *    Collapsing them would make an untouched item read as hidden.
 *
 * 2. AN UNCHANGED FOLD RETURNS THE SAME ARRAY REFERENCE. ServiceRoundScreen folds the result
 *    straight back into React state inside useFocusEffect. A fresh-but-equal array would make
 *    setState see a new value on every single focus and re-render the whole menu grid forever.
 *    This is the assertion that stops a render loop being introduced by an innocent-looking
 *    `return items.map(...)`.
 *
 * SEEN TO FAIL (deliberately, then reverted): drop the `changed` flag from
 * applyAvailabilityOverrides and always `return next`. "returns the SAME array when the override
 * already agrees with the record" fails on two arrays that are equal but not the same object.
 *
 * Note which one did NOT fail: "returns the SAME array when nothing was overridden" still passed,
 * because the empty-store early return short-circuits before the map. The two identity tests are
 * therefore not duplicates — the second covers the case a running device is actually in, where
 * something HAS been recorded and most rows are still untouched by it.
 */
import {
  applyAvailabilityOverrides,
  availabilityOverride,
  clearAvailabilityOverrides,
  recordAvailabilityChange,
} from '../menuAvailabilityOverrides';

type Row = {id: string; is_available: boolean; name: string};

const rows = (): Row[] => [
  {id: 'a', is_available: true, name: 'Beef Fillet'},
  {id: 'b', is_available: true, name: 'Grilled Kingklip'},
];

describe('menu availability overrides', () => {
  beforeEach(clearAvailabilityOverrides);

  it('reports null for an item this device has not changed', () => {
    expect(availabilityOverride('a')).toBeNull();

    recordAvailabilityChange('a', false);

    // Not null, and specifically false — the two must not be confusable.
    expect(availabilityOverride('a')).toBe(false);
    expect(availabilityOverride('b')).toBeNull();
  });

  it('applies a recorded change to a list fetched earlier', () => {
    recordAvailabilityChange('b', false);

    const applied = applyAvailabilityOverrides(rows());

    expect(applied[0].is_available).toBe(true);
    expect(applied[1].is_available).toBe(false);
    // Everything else about the row survives — this patches availability, it does not rebuild rows.
    expect(applied[1].name).toBe('Grilled Kingklip');
  });

  it('returns the SAME array when nothing was overridden', () => {
    const original = rows();
    expect(applyAvailabilityOverrides(original)).toBe(original);
  });

  it('returns the SAME array when the override already agrees with the record', () => {
    // The item is already available and the server confirmed available. Nothing to patch.
    recordAvailabilityChange('a', true);

    const original = rows();
    expect(applyAvailabilityOverrides(original)).toBe(original);
  });

  it('returns a NEW array only when something actually changed', () => {
    recordAvailabilityChange('a', false);

    const original = rows();
    expect(applyAvailabilityOverrides(original)).not.toBe(original);
  });

  it('records a restore as well as a hide', () => {
    recordAvailabilityChange('a', false);
    recordAvailabilityChange('a', true);

    expect(availabilityOverride('a')).toBe(true);
    expect(applyAvailabilityOverrides(rows())[0].is_available).toBe(true);
  });
});
