/**
 * Order-card timestamp formatting.
 *
 * One OrderCard serves every tab. New/Preparing/Ready only ever hold today's orders, so a
 * bare time is right there. The Completed tab deliberately retains history (OrdersScreen
 * keeps completed orders visible so staff can reach the refund entry point), so a bare time
 * makes a three-day-old order indistinguishable from a ten-minute-old one.
 *
 * Deciding on the age of the order rather than on which tab is showing it keeps this one
 * component and means a stale card is labelled correctly wherever it appears.
 */

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Today -> `6:35 AM` (unchanged). Any other day -> `03 Aug, 6:35 AM`.
 *
 * `now` is injectable so the today/not-today boundary is testable; production passes nothing.
 * An unparseable timestamp falls through to the same string the bare-time path produced
 * before, rather than being swallowed into a blank card.
 */
export function formatOrderCardTime(iso: string, now: Date = new Date()): string {
  const placed = new Date(iso);
  const time = placed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (Number.isNaN(placed.getTime()) || isSameCalendarDay(placed, now)) {
    return time;
  }
  const date = placed.toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
  });
  return `${date}, ${time}`;
}
