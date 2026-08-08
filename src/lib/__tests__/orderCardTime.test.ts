import {formatOrderCardTime} from '../orderCardTime';

/**
 * Expectations are built with the same Intl calls the implementation uses, so these assertions
 * hold on any locale/timezone. Dates are constructed with the local-time Date constructor and
 * handed over as ISO, so the rendered local calendar day is the one under test.
 */
const bareTime = (d: Date) =>
  d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
const datePart = (d: Date) =>
  d.toLocaleDateString([], {day: '2-digit', month: 'short'});

const at = (y: number, m: number, day: number, h: number, min: number) =>
  new Date(y, m, day, h, min, 0, 0);

describe('formatOrderCardTime', () => {
  const now = at(2026, 7, 6, 14, 0); // 06 Aug 2026, 14:00 local

  it('renders a bare time for an order placed today (live tabs stay clean)', () => {
    const placed = at(2026, 7, 6, 6, 35);
    expect(formatOrderCardTime(placed.toISOString(), now)).toBe(bareTime(placed));
  });

  it('renders the date for an order from a previous day (#168: Completed tab)', () => {
    const placed = at(2026, 7, 3, 6, 35);
    const out = formatOrderCardTime(placed.toISOString(), now);

    expect(out).toBe(`${datePart(placed)}, ${bareTime(placed)}`);
    // The regression itself: a three-day-old order must not look like a fresh one.
    expect(out).not.toBe(bareTime(placed));
  });

  it('renders the date for yesterday, not just for distant orders', () => {
    const placed = at(2026, 7, 5, 23, 50);
    expect(formatOrderCardTime(placed.toISOString(), now)).toBe(
      `${datePart(placed)}, ${bareTime(placed)}`,
    );
  });

  it('distinguishes the same day-of-month in a different month', () => {
    const placed = at(2026, 6, 6, 14, 0); // 06 Jul — same date number, same time
    expect(formatOrderCardTime(placed.toISOString(), now)).toBe(
      `${datePart(placed)}, ${bareTime(placed)}`,
    );
  });

  it('distinguishes the same day and month in a different year', () => {
    const placed = at(2025, 7, 6, 14, 0);
    expect(formatOrderCardTime(placed.toISOString(), now)).toBe(
      `${datePart(placed)}, ${bareTime(placed)}`,
    );
  });

  it('leaves an unparseable timestamp as the bare-time path rendered it before', () => {
    expect(formatOrderCardTime('not-a-date', now)).toBe(
      new Date('not-a-date').toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  });
});
