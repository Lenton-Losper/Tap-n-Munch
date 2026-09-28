/**
 * "CHECK THE TABLE" AFTER A ROUND WHOSE OUTCOME IS UNKNOWN. (Sprint 2026-09-28 brief.)
 *
 * The send timed out, or the connection dropped, or the server 5xx'd. The terminal cannot see the
 * idempotency key on the tab's orders, so this looks for an order that could BE this round: placed
 * since the first Send (by the SERVER's own `seconds_since_placed`, so device clock skew cannot
 * matter) and carrying every item in the round.
 *
 * IT IS A HINT FOR THE WAITER, NEVER A RESOLUTION. A match does not unlock the basket: another
 * device could have sent the same dishes to the same table. The only definite answer is re-sending
 * the same round under the same key, which the server answers with `duplicate: true` if it already
 * has it. That is why the screen always offers Retry, and never "that's it, done".
 */
import type {TabLineOrder, TabLinesPayload} from './tabLines';

/** Seconds of slack on top of the elapsed time, for the server's own processing. */
const PLACED_SLACK_SECONDS = 60;

export function findRoundOnTab(
  payload: TabLinesPayload,
  items: {name: string; quantity: number}[],
  secondsSinceFirstSend: number,
): TabLineOrder | null {
  if (items.length === 0) {
    return null;
  }
  const window = Math.max(0, secondsSinceFirstSend) + PLACED_SLACK_SECONDS;
  const candidates = payload.orders
    .filter(
      order =>
        order.seconds_since_placed != null && order.seconds_since_placed <= window,
    )
    // Newest first: the most recent placement is the likeliest to be this Send.
    .sort((a, b) => (a.seconds_since_placed ?? 0) - (b.seconds_since_placed ?? 0));

  for (const order of candidates) {
    const live = order.lines.filter(line => !line.is_voided);
    const everyItemPresent = items.every(item => {
      const have = live
        .filter(line => line.name_snapshot.startsWith(item.name))
        .reduce((sum, line) => sum + line.quantity, 0);
      return have >= item.quantity;
    });
    if (everyItemPresent) {
      return order;
    }
  }
  return null;
}
