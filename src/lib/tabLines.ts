/**
 * Waiter-led service v2 — the pure half of the TABLE VIEW and of the floor grid's warning flag.
 *
 * Everything here is free of React and of `fetch`, so the one rule that decides what a waiter
 * believes about a table — when a table is flagged as needing attention — is pinned by tests
 * rather than by reading a screen.
 *
 * Source: `GET /api/terminal/tabs/{tabId}/lines`.
 */

/** One fulfilment line. `is_ready` is the SERVER's verdict — see deriveTableFlag. */
export interface TabLine {
  id: string;
  name_snapshot: string;
  quantity: number;
  line_note: string | null;
  route_to: string | null;
  kitchen_state: string | null;
  bar_state: string | null;
  is_ready: boolean;
  is_voided: boolean;
  unrouted: boolean;
}

export interface TabLineOrder {
  order_id: string;
  order_number: number;
  order_instructions: string | null;
  order_total: number;
  placed_at: string;
  /** The SERVER's arithmetic. Never rebuilt from placed_at and the device clock. */
  seconds_since_placed: number | null;
  lines: TabLine[];
}

export interface TabLineSummary {
  /**
   * FULFILMENT LINES, NOT ITEMS SOLD. An item routed to both kitchen and bar is ONE line here.
   * Never render this as a quantity — a table with one both-routed item is "1 line", and calling
   * that "1 item" is a coincidence that stops being true the moment quantities exceed one.
   */
  total_lines: number;
  outstanding: number;
  ready: number;
  voided: number;
}

export interface TabLinesPayload {
  tab: {
    id: string;
    table_number: number;
    status: string;
    total: number;
    opened_at: string | null;
    opened_by_user_id: string | null;
  };
  orders: TabLineOrder[];
  summary: TabLineSummary;
  all_ready: boolean;
  /**
   * FALSE means this tab predates the waiter flow, or came in over QR: it has a bill but no
   * fulfilment lines at all. The table view must then show the money and CLAIM NOTHING ABOUT
   * READINESS — no "all ready", no per-line chips, no flag on the floor.
   */
  has_lines: boolean;
  server_time: string | null;
}

/**
 * How long a line may sit outstanding before the floor grid says something.
 *
 * THIS NUMBER IS NOT MEASURED, and it is the only figure in this feature that is not. The repo's
 * other timing constants (PAYMENT_ADVISORY_CEILING_S) come from production percentiles; there is
 * no equivalent sample for ticket age, because until this release nothing recorded when a line was
 * placed against when it went out. 20 minutes is a starting guess at "a waiter would want to know",
 * chosen high enough not to cry wolf during an ordinary main course.
 *
 * It needs calibrating against real service data before it is trusted. Flagged in the handover.
 */
export const OUTSTANDING_ATTENTION_SECONDS = 20 * 60;

/**
 * What the floor grid shows against a table, DERIVED FROM LINE STATE ON EVERY RENDER.
 *
 * Never a stored value and never a column: there is no "needs attention" field anywhere in the
 * system, deliberately, because a stored flag is a fact that was true once and goes stale silently.
 * This is recomputed from the lines each time they are fetched, so a flag that should have cleared
 * cannot survive its own cause.
 */
export type TableFlag = 'ready' | 'waiting' | 'unrouted' | null;

/**
 * The warning flag for one table.
 *
 * PRECEDENCE IS DELIBERATE, most actionable first:
 *
 *   unrouted  a line reached no station at all. Nobody is cooking it and nobody will — this is the
 *             only state where the food is not merely late but absent from every pass. It outranks
 *             everything because it is the one a waiter cannot discover by waiting.
 *   ready     food is up and sitting under the pass going cold. Outranks 'waiting' because it is
 *             the one the waiter can act on RIGHT NOW by walking over and collecting it.
 *   waiting   something has been outstanding longer than OUTSTANDING_ATTENTION_SECONDS.
 *
 * `is_ready` comes from the server and is NOT recomputed here. It is produced by the same
 * definition the kitchen and bar station screens use, and a second definition on the device is
 * exactly how a waiter comes to believe a table is ready that the kitchen does not consider ready.
 * kitchen_state and bar_state are carried for display only.
 *
 * A tab with no lines gets NO FLAG. has_lines: false means there is nothing to be ready or late —
 * a QR or pre-migration tab — and inventing a badge for it would be asserting something the
 * payload explicitly declines to say.
 */
export function deriveTableFlag(payload: TabLinesPayload | null | undefined): TableFlag {
  if (!payload || !payload.has_lines) {
    return null;
  }

  const live = payload.orders.flatMap(order =>
    order.lines
      .filter(line => !line.is_voided)
      .map(line => ({line, order})),
  );

  if (live.length === 0) {
    return null;
  }

  if (live.some(({line}) => line.unrouted)) {
    return 'unrouted';
  }

  // all_ready is the server's own summary and is preferred over re-deriving it from the array,
  // for the same reason is_ready is: one definition, server-side.
  if (payload.all_ready) {
    return 'ready';
  }

  const stale = live.some(
    ({line, order}) =>
      !line.is_ready &&
      order.seconds_since_placed != null &&
      order.seconds_since_placed >= OUTSTANDING_ATTENTION_SECONDS,
  );

  return stale ? 'waiting' : null;
}

/**
 * The oldest outstanding line's age, in seconds, or null when nothing is outstanding.
 *
 * Uses the server's `seconds_since_placed` per order. Callers may add locally-measured elapsed
 * time between refreshes — a duration is safe — but must never rebuild this from `placed_at` and
 * the device clock, which on a terminal off a shelf is not trustworthy.
 */
export function oldestOutstandingSeconds(
  payload: TabLinesPayload | null | undefined,
): number | null {
  if (!payload || !payload.has_lines) {
    return null;
  }
  let oldest: number | null = null;
  for (const order of payload.orders) {
    const hasOutstanding = order.lines.some(
      line => !line.is_voided && !line.is_ready,
    );
    if (!hasOutstanding || order.seconds_since_placed == null) {
      continue;
    }
    if (oldest == null || order.seconds_since_placed > oldest) {
      oldest = order.seconds_since_placed;
    }
  }
  return oldest;
}

/**
 * Money owed on the tab, taken from the payload's own `tab.total`.
 *
 * The server's figure, not a sum of `order_total` — a client-side sum would silently disagree with
 * the bill the customer is shown the moment a discount, a void or a service charge exists.
 */
export function tabRunningTotal(
  payload: TabLinesPayload | null | undefined,
): number {
  const total = Number(payload?.tab?.total);
  return Number.isFinite(total) ? total : 0;
}

/** Counts real ITEMS (sum of quantities on non-voided lines), which total_lines is not. */
export function itemCount(payload: TabLinesPayload | null | undefined): number {
  if (!payload) {
    return 0;
  }
  return payload.orders.reduce(
    (sum, order) =>
      sum +
      order.lines.reduce(
        (n, line) => (line.is_voided ? n : n + (Number(line.quantity) || 0)),
        0,
      ),
    0,
  );
}

/** `1h 15m`, `20m`, `just now`. Same contract as formatSecondsOpen: the argument is a duration. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return 'just now';
}
