/**
 * Waiter-led service v2 — the pure half of the TABLE VIEW and of the floor grid's warning flag.
 *
 * Everything here is free of React and of `fetch`, so the one rule that decides what a waiter
 * believes about a table — when a table is flagged as needing attention — is pinned by tests
 * rather than by reading a screen.
 *
 * Source: `GET /api/terminal/tabs/{tabId}/lines`.
 */

/** One fulfilment line. `is_ready` is the SERVER's verdict — see deriveTableBadge. */
export interface TabLine {
  id: string;
  name_snapshot: string;
  quantity: number;
  line_note: string | null;
  route_to: string | null;
  /**
   * PARSED AND CURRENTLY RENDERED NOWHERE. Both fields are one of `outstanding` / `cooked` /
   * `ready` / `voided`, per station, and they are the raw material behind `is_ready`.
   *
   * A previous version of this comment claimed they were "carried for display only", which was
   * false: no screen in this app reads either field. They are kept because they are the only place
   * the device can see PARTIAL progress on a both-routed item — kitchen done, bar still pouring —
   * which `is_ready` collapses to a single false. Nothing renders that yet and nothing should start
   * without wording, so the honest statement is that they are carried, unread, on purpose.
   *
   * Do not derive readiness from them. `is_ready` is the server's single definition; a second one
   * on the device is how a waiter comes to believe a table is ready that the kitchen does not.
   */
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
 * The flag for one table, plus how many lines are actually up.
 *
 * The count exists because 'ready' stopped being all-or-nothing (see deriveTableBadge). READY
 * against a table now means "there is food on the pass for this table", and the only honest way to
 * say how much is to say the number.
 */
export interface TableBadge {
  flag: TableFlag;
  /**
   * Non-voided lines the SERVER says are ready. Zero for every flag except 'ready', and callers
   * must treat zero as "render no number" rather than "render 0" — a badge reading READY 0 is a
   * contradiction, and it is reachable if a payload ever sets all_ready without setting is_ready on
   * any line.
   */
  readyCount: number;
}

const NO_BADGE: TableBadge = {flag: null, readyCount: 0};

/**
 * The flag for one table.
 *
 * PRECEDENCE IS DELIBERATE, most actionable first:
 *
 *   unrouted  a line reached no station at all. Nobody is cooking it and nobody will — this is the
 *             only state where the food is not merely late but absent from every pass. It outranks
 *             everything because it is the one a waiter cannot discover by waiting.
 *   ready     AT LEAST ONE non-voided line is ready. Food is on the pass going cold, and the waiter
 *             can act on it RIGHT NOW by walking over and collecting it.
 *   waiting   nothing is up yet AND something has been outstanding longer than
 *             OUTSTANDING_ATTENTION_SECONDS.
 *
 * WHY 'ready' IS NO LONGER GATED ON all_ready.
 *
 * It used to be. `all_ready` is true only when EVERY non-voided line on the WHOLE TAB is ready, so
 * a table with three plates on the pass and one main still cooking fell through to the staleness
 * check and rendered amber WAITING — telling a waiter there was nothing to collect at the exact
 * moment there was. A tab in real service almost always has something outstanding (a later round, a
 * dessert, a second drink), so the old rule fired the green badge mostly on tabs whose food had
 * already been run and stayed silent on the ones that needed a runner. It also meant sending a new
 * round onto a tab whose starters were up made the READY badge DISAPPEAR.
 *
 * So the rule is now "is there anything to collect", not "is this table finished". A partially
 * ready tab must never render as 'waiting'; that inversion is the whole defect.
 *
 * `all_ready` is still consulted, but only as a belt-and-braces OR: if the server says the tab is
 * complete we show 'ready' even in the shape where no individual line carries is_ready. It no
 * longer gates anything.
 *
 * `is_ready` comes from the server and is NOT recomputed here. It is produced by the same
 * definition the kitchen and bar station screens use, and a second definition on the device is
 * exactly how a waiter comes to believe a table is ready that the kitchen does not consider ready.
 *
 * THE COUNT IS AGGREGATED FROM `is_ready`, NOT READ FROM `summary.ready`, and that is a deliberate
 * choice between two server-side figures. `summary.ready` counts fulfilment lines by the server's
 * own reckoning; `is_ready` is the per-line flag the table view renders its Ready chips from. The
 * grid and the table view must agree — a floor badge reading READY 2 above a table screen showing
 * three Ready chips destroys a waiter's trust in both — so the badge counts exactly what the chips
 * count. Neither figure is rebuilt from kitchen_state/bar_state.
 *
 * A tab with no lines gets NO FLAG. has_lines: false means there is nothing to be ready or late —
 * a QR or pre-migration tab — and inventing a badge for it would be asserting something the payload
 * explicitly declines to say.
 *
 * WHAT THIS CANNOT KNOW: nothing in the system records that food was COLLECTED, so a line stays
 * ready forever once the kitchen bumps it. The badge therefore means "food has been up as of the
 * last refresh", NOT "food is still sitting there" — a waiter who has already run the plates keeps
 * seeing the badge until the rest of the tab lands. See docs/collected-state-proposal.md; that
 * missing transition is precisely why this is a badge on a table and not a runner's work list.
 */
export function deriveTableBadge(
  payload: TabLinesPayload | null | undefined,
): TableBadge {
  if (!payload || !payload.has_lines) {
    return NO_BADGE;
  }

  const live = payload.orders.flatMap(order =>
    order.lines
      .filter(line => !line.is_voided)
      .map(line => ({line, order})),
  );

  if (live.length === 0) {
    return NO_BADGE;
  }

  if (live.some(({line}) => line.unrouted)) {
    return {flag: 'unrouted', readyCount: 0};
  }

  const readyCount = live.reduce(
    (count, {line}) => (line.is_ready ? count + 1 : count),
    0,
  );

  if (readyCount > 0 || payload.all_ready) {
    return {flag: 'ready', readyCount};
  }

  const stale = live.some(
    ({line, order}) =>
      !line.is_ready &&
      order.seconds_since_placed != null &&
      order.seconds_since_placed >= OUTSTANDING_ATTENTION_SECONDS,
  );

  return stale ? {flag: 'waiting', readyCount: 0} : NO_BADGE;
}

/** The flag alone, for callers that do not render the count. */
export function deriveTableFlag(
  payload: TabLinesPayload | null | undefined,
): TableFlag {
  return deriveTableBadge(payload).flag;
}

/**
 * Fold a pass of freshly-fetched badges into the ones already on screen.
 *
 * WHY THIS IS NOT JUST `setBadges(fetched)`.
 *
 * The grid decorates itself with one request PER OPEN TABLE and swallows every failure, because a
 * banner per failed tab would cover the floor in warnings. Rebuilding the map from only the
 * requests that succeeded meant one dropped response erased that table's badge until the next pass,
 * so a READY badge blinked out and back rather than staying put, and a waiter glancing at the grid
 * between blinks saw nothing at all. A transient network failure must not be able to un-say "there
 * is food on the pass".
 *
 * So a table that was ATTEMPTED and FAILED keeps whatever it last successfully reported.
 *
 * WHAT STOPS STALE BADGES ACCUMULATING FOREVER: `eligibleTableIds`. Only tables the CURRENT floor
 * payload says are open and carrying a tab survive the merge; everything else is dropped whether it
 * had a badge or not. That payload comes from the grid's own poll, which is a SINGLE request that
 * succeeds or fails independently of the per-tab fetches — so a table that is settled, closed,
 * freed, or has simply vanished from the floor loses its badge on the next successful grid poll
 * even while its own lines endpoint keeps failing. A retained badge is bounded twice: it is only
 * ever as old as that table's last successful read, and it cannot outlive the table's presence on
 * the floor as an open tab.
 *
 * A fetched value whose flag is null is a REAL ANSWER — "read this tab fine, nothing to flag" — and
 * correctly overwrites a previous badge. Only an ABSENT KEY means "we did not find out".
 */
export function mergeTableBadges(
  previous: Readonly<Record<string, TableBadge>>,
  fetched: Readonly<Record<string, TableBadge>>,
  eligibleTableIds: readonly string[],
): Record<string, TableBadge> {
  const next: Record<string, TableBadge> = {};
  for (const id of eligibleTableIds) {
    if (Object.prototype.hasOwnProperty.call(fetched, id)) {
      next[id] = fetched[id];
    } else if (Object.prototype.hasOwnProperty.call(previous, id)) {
      next[id] = previous[id];
    }
  }
  return next;
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
