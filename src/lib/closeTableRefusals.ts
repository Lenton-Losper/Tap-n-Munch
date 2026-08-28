/**
 * WHAT CLOSE TABLE REFUSES, AND NOTHING ELSE.
 *
 * SETTLING IS NOT CLOSING. A tab carries `status` AND `settled_at`, and the settle route treats
 * them as different facts: money having arrived does not end the session. Only Close Table ends a
 * session. Nothing in this file may ever CLOSE a table as a consequence of it having been paid,
 * and nothing in it may refuse a close merely because a tab HAS been settled — a settled tab is
 * the normal, expected input to closing.
 *
 * ─── THIS FILE IS THE POLICY ────────────────────────────────────────────────────────────────
 *
 * `CLOSE_TABLE_REFUSAL_RULES` below is the ONE list. To make Close Table stop refusing something,
 * delete or amend exactly one entry in that array; to make it start refusing something, add one.
 * No screen, no component and no API wrapper re-decides any of this. That is the whole point of
 * the module existing: a refusal set spread across three screens is a refusal set nobody can state
 * out loud, and one that drifts the first time a screen is edited.
 *
 * ─── THE DEFAULT IS TO REFUSE ───────────────────────────────────────────────────────────────
 *
 * Every rule that depends on a fact answers "refuse" when that fact is MISSING rather than when it
 * is merely inconvenient. A close is irreversible from the floor: it ends the session, frees the
 * table, and detaches anything still attached to it. Wrongly refusing costs a waiter a walk to the
 * dashboard. Wrongly allowing loses a debt, an order, or a card payment that is still in the air.
 * Those are not symmetric, so the tie is broken towards refusal every time.
 *
 * ─── NONE OF THIS IS SIGNED OFF ─────────────────────────────────────────────────────────────
 *
 * The owner rules on the refusal set; this file is the proposal, defaulted safe. Each rule's
 * docblock states the condition, how it is detected, and what allowing it would cost, so the
 * ruling can be made against the consequence rather than against the name.
 *
 * ─── WHAT THIS FILE CANNOT SEE ──────────────────────────────────────────────────────────────
 *
 * PENDING ORDER REQUESTS — a customer round awaiting staff review, or a stranded `accepting`
 * claim — block a close SERVER-SIDE with a 409 `PENDING_ORDER_REQUESTS`, and neither payload this
 * device can fetch carries them. That refusal is real and it is not in this list because it cannot
 * be. It is handled after the fact, by not swallowing the 409. See CloseTableAction.
 */

import {
  isMidFlightCardPayment,
  owesMoney,
} from './paymentIntegrity';
import {TabLinesPayload} from './tabLines';
import {TableWithTab} from '../types';

/**
 * Every reason a close can be refused BEFORE the request is sent.
 *
 * The ids are stable and are what the copy table and the tests key on. Renaming one is a breaking
 * change to both; adding one requires an entry in CLOSE_TABLE_REFUSAL_COPY or the exhaustive
 * Record type stops compiling, which is the point.
 */
export type CloseTableRefusalId =
  | 'TABLE_UNKNOWN'
  | 'LINES_UNKNOWN'
  | 'TAB_STATUS_UNKNOWN'
  | 'SERVER_REFUSES'
  | 'UNPAID_BALANCE'
  | 'ORDER_OWES_MONEY'
  | 'CARD_PAYMENT_IN_FLIGHT'
  | 'CARD_PAYMENT_STUCK'
  | 'OUTSTANDING_LINE'
  | 'UNROUTED_LINE'
  | 'LINE_TRACKING_UNAVAILABLE'
  | 'UNSENT_ROUND_ON_DEVICE';

/**
 * Everything the refusal set is allowed to look at, gathered at the moment the waiter asks to
 * close — never earlier. A snapshot taken on screen load and consulted two minutes later would be
 * answering about a table that has since been paid, cooked for, or charged.
 *
 * `table` and `lines` are nullable ON PURPOSE. Null does not mean "no problem"; it means the
 * device could not read that half of the truth, and rules 1 and 2 turn that into a refusal.
 */
export interface CloseTableSnapshot {
  /** `/api/terminal/tables` — the money view. Null when it could not be read or had no such row. */
  table: TableWithTab | null;
  /** `/api/terminal/tabs/{id}/lines` — the fulfilment view. Null when it could not be read. */
  lines: TabLinesPayload | null;
  /**
   * The server's own card-in-flight timeout, from the tables payload. Null when the server did not
   * say, which is why CARD_PAYMENT_STUCK cannot fire without it and an in-flight card falls to
   * CARD_PAYMENT_IN_FLIGHT instead — "possibly still live" is the safe reading of "we don't know".
   */
  cardInFlightTimeoutSeconds: number | null;
  /** Lines sitting in THIS device's unsent basket for THIS tab. Device-local, server knows nothing. */
  unsentRoundLineCount: number;
}

interface CloseTableRule {
  id: CloseTableRefusalId;
  refuses: (snapshot: CloseTableSnapshot) => boolean;
}

function liveLines(lines: TabLinesPayload | null) {
  if (!lines || !lines.has_lines) {
    return [];
  }
  return lines.orders.flatMap(order => order.lines.filter(line => !line.is_voided));
}

/**
 * Orders with a card payment the reader has not finished with.
 *
 * TWO detections, not one, and either is enough. `card_payment_in_flight` is the server's own
 * projection and is the field to trust; `terminal_pending` is the underlying payment_status and is
 * checked as well because the projection is OPTIONAL on the type — an older worker omits it, and
 * an absent boolean read as false is exactly how a live card charge becomes invisible.
 */
function cardInFlightOrders(table: TableWithTab | null) {
  const orders = table?.tab?.orders ?? [];
  return orders.filter(
    order =>
      order.card_payment_in_flight === true ||
      isMidFlightCardPayment(order.payment_status),
  );
}

/**
 * ═══ THE REFUSAL SET ═══
 *
 * Ordered most fundamental first, so the sheet a waiter reads leads with the reason that explains
 * the others. EVERY rule fires independently — the evaluation does not stop at the first, because
 * a table that is both unpaid and still cooking should say so once rather than twice.
 */
export const CLOSE_TABLE_REFUSAL_RULES: readonly CloseTableRule[] = [
  /**
   * 1. THE MONEY VIEW DID NOT LOAD.
   *
   * CONDITION: `/api/terminal/tables` failed, or answered with no row for this table.
   * DETECTION: `snapshot.table == null`.
   * ALLOWING IT: closes with no idea whether anything is owed. Every money rule below silently
   * passes when its input is missing, so this rule is what stops "could not read" reading as
   * "nothing to pay".
   */
  {id: 'TABLE_UNKNOWN', refuses: s => s.table == null},

  /**
   * 2. THE FULFILMENT VIEW DID NOT LOAD.
   *
   * CONDITION: `/api/terminal/tabs/{id}/lines` failed.
   * DETECTION: `snapshot.lines == null`.
   * ALLOWING IT: closes without knowing whether a single item is still on the pass.
   */
  {id: 'LINES_UNKNOWN', refuses: s => s.lines == null},

  /**
   * 3. THE SERVER DID NOT NAME THE TAB'S STATE.
   *
   * CONDITION: the lines payload carried no `tab.status` at all — getTabLines defaults the field
   * to an empty string precisely so its absence is visible rather than guessed at.
   * DETECTION: `lines.tab.status` is empty after trimming.
   * ALLOWING IT: acts on a tab whose state the server declined to state.
   *
   * DELIBERATELY NOT A LIST OF STATUS STRINGS. The tab status vocabulary is not pinned anywhere on
   * this device — `ready_to_pay` is the only value the client has ever matched on — and a rule
   * that refused every unrecognised status would refuse every close in production the first time
   * the server added one. Refusing only on "the server said nothing" is the part that is knowable
   * from here. The rest is flagged for the owner.
   */
  {
    id: 'TAB_STATUS_UNKNOWN',
    refuses: s => s.lines != null && String(s.lines.tab.status ?? '').trim() === '',
  },

  /**
   * 4. THE SERVER'S OWN VERDICT IS NO.
   *
   * CONDITION: the tables payload's `can_close` is anything other than exactly true.
   * DETECTION: `table.can_close !== true` — not `=== false`, so an older server that omits the
   * field refuses rather than closes.
   * ALLOWING IT: the device overrides the server's closeability computation and sends a request
   * the close route is going to reject anyway, turning a clear refusal into a failed POST.
   */
  {
    id: 'SERVER_REFUSES',
    refuses: s => s.table != null && s.table.can_close !== true,
  },

  /**
   * 5. THE TAB STILL OWES MONEY.
   *
   * CONDITION: the tab's unpaid total is above zero.
   * DETECTION: `table.tab.unpaid_total > 0`. The SERVER's figure. Never a client sum of order
   * totals, which disagrees with the bill the moment a void, discount or service charge exists.
   * ALLOWING IT: ends the session on an unpaid bill. The debt does not vanish, but it loses the
   * table it was attached to, and the floor no longer shows anyone that it is owed.
   */
  {
    id: 'UNPAID_BALANCE',
    refuses: s => Number(s.table?.tab?.unpaid_total ?? 0) > 0,
  },

  /**
   * 6. AN INDIVIDUAL ORDER STILL OWES MONEY.
   *
   * CONDITION: any order on the tab sits in a status where the restaurant has not been paid —
   * unpaid, pending, cash_pending, failed or terminal_pending.
   * DETECTION: `owesMoney(order.payment_status)`, the set already mirrored from the server in
   * lib/paymentIntegrity. Cancelled and paid are absent from that set by design.
   * ALLOWING IT: the same loss as rule 5.
   *
   * KEPT SEPARATE FROM RULE 5 ON PURPOSE, even though they usually agree. When they disagree the
   * two directions are different bugs — a stale `unpaid_total` recalculation (the settle route
   * admits its own recalculation can be untrusted, via `tab_total_stale`) versus an order whose
   * status the total has not caught up with — and collapsing them into one rule would hide which.
   */
  {
    id: 'ORDER_OWES_MONEY',
    refuses: s =>
      (s.table?.tab?.orders ?? []).some(order => owesMoney(order.payment_status)),
  },

  /**
   * 7. A CARD IS ON THE READER RIGHT NOW.
   *
   * CONDITION: an order has a card payment in flight that has not yet outlived the server's
   * timeout for one.
   * DETECTION: `card_payment_in_flight`, or a `terminal_pending` payment_status — see
   * cardInFlightOrders for why both — AND the elapsed time is unknown, or within
   * `cardInFlightTimeoutSeconds`. An unknown elapsed time counts as still live.
   * ALLOWING IT: the close races the gateway callback. The payment lands against a session that no
   * longer exists and becomes an orphan — the exact condition this app already carries a held-
   * orphan-payment apparatus to clean up after.
   */
  {
    id: 'CARD_PAYMENT_IN_FLIGHT',
    refuses: s =>
      cardInFlightOrders(s.table).some(order => {
        const elapsed = order.card_in_flight_seconds;
        const timeout = s.cardInFlightTimeoutSeconds;
        if (elapsed == null || timeout == null) {
          return true;
        }
        return elapsed <= timeout;
      }),
  },

  /**
   * 8. A CARD PAYMENT HAS BEEN IN FLIGHT LONGER THAN THE SERVER ALLOWS.
   *
   * CONDITION: a `terminal_pending` order whose in-flight time has passed
   * `cardInFlightTimeoutSeconds`, so the server will no longer accept a settle claim against it.
   * DETECTION: as rule 7, but elapsed and timeout both known and elapsed above timeout.
   * ALLOWING IT: this is the ONE case where money may already have left the customer's account
   * with no answer ever having come back. Closing removes the session that outcome would attach
   * to. It is also the case with the strongest argument FOR allowing — the order is stuck and the
   * table is otherwise finished — which is exactly why it is its own rule rather than folded into
   * rule 7: the owner can allow this one without also allowing a live charge to be closed over.
   *
   * DEFAULTED TO REFUSE because "we never found out what happened to this card" is not a state to
   * end a session on by default.
   */
  {
    id: 'CARD_PAYMENT_STUCK',
    refuses: s =>
      cardInFlightOrders(s.table).some(order => {
        const elapsed = order.card_in_flight_seconds;
        const timeout = s.cardInFlightTimeoutSeconds;
        if (elapsed == null || timeout == null) {
          return false;
        }
        return elapsed > timeout;
      }),
  },

  /**
   * 9. SOMETHING IS STILL COOKING.
   *
   * CONDITION: a non-voided fulfilment line the server does not consider ready.
   * DETECTION: `!line.is_voided && !line.is_ready` over the lines payload. `is_ready` is the
   * SERVER's verdict, produced by the same definition the kitchen and bar screens use, and is not
   * recomputed here from kitchen_state/bar_state — a second definition on the device is how a
   * waiter comes to believe a table is ready that the kitchen does not.
   * ALLOWING IT: closes a table whose food is still on the pass. The station screen keeps a ticket
   * for a table that no longer exists, and the round is plated for nobody.
   */
  {
    id: 'OUTSTANDING_LINE',
    refuses: s => liveLines(s.lines).some(line => !line.is_ready),
  },

  /**
   * 10. A LINE REACHED NO STATION AT ALL.
   *
   * CONDITION: a non-voided line flagged `unrouted` — sold, but never sent anywhere.
   * DETECTION: `line.unrouted && !line.is_voided`.
   * ALLOWING IT: differs from rule 9 in that waiting will never clear it. Nobody is making this
   * item and nobody is going to. Closing files that away silently, and the customer paid for it.
   *
   * SEPARATE FROM RULE 9 even though an unrouted line is also never ready, because the two
   * warrant different rulings: "let them close over food that is late" is a plausible policy,
   * "let them close over food nobody will ever cook" is a different question.
   */
  {
    id: 'UNROUTED_LINE',
    refuses: s => liveLines(s.lines).some(line => line.unrouted),
  },

  /**
   * 11. READINESS IS NOT TRACKED FOR THIS TAB.
   *
   * CONDITION: `has_lines: false` — a tab that predates the waiter flow or came in over QR. It has
   * a bill, and no fulfilment lines at all.
   * DETECTION: `lines.has_lines !== true`.
   * ALLOWING IT: closes without being able to answer "is anything still cooking", because for this
   * tab the question has no recorded answer. Rules 9 and 10 cannot fire on such a tab — they have
   * nothing to read — so without this rule those two silently pass for every QR table.
   *
   * RULED BY THE OWNER 2026-08-28, and this rule NO LONGER REFUSES OUTRIGHT.
   *
   * Refusing every QR-opened table was wrong: those tables exist at Mingle and ChowNow today and
   * staff must be able to close them. But the original author was right that rules 9 and 10 cannot
   * fire here, so line safety genuinely is unchecked.
   *
   * The ruling: "Money is knowable on a QR tab even when lines are not, so check what you can and
   * do not pretend to check what you cannot." A settled bill closes; anything owed refuses.
   *
   * The waiter is therefore taking on the readiness question the system cannot answer, and the
   * confirm sheet says so on this path (see CLOSE_CONFIRM_BODY_NO_LINE_TRACKING). That sentence is
   * the whole safeguard, so it must not be dropped as duplicative of the ordinary confirm body.
   */
  {
    id: 'LINE_TRACKING_UNAVAILABLE',
    refuses: s => {
      // Tracking is present, or the lines could not be read at all — rule 2 owns that case.
      if (s.lines == null || s.lines.has_lines === true) {
        return false;
      }

      /**
       * DELIBERATELY SELF-CONTAINED rather than leaning on rules 5 and 6 to catch the owed case.
       * They do catch it today, and this duplicates them on purpose: if either is ever ruled away,
       * this must not silently become "close any QR table regardless of the bill".
       *
       * A money view that could not be read REFUSES here. "We cannot tell" is not "nothing owed" —
       * the same trap the cancelled-tab chip exists for.
       */
      const tab = s.table?.tab;
      if (tab == null) {
        return true;
      }

      const nothingOwed =
        Number(tab.unpaid_total ?? 0) === 0 &&
        !(tab.orders ?? []).some(order => owesMoney(order.payment_status));

      return !nothingOwed;
    },
  },

  /**
   * 12. THIS DEVICE IS HOLDING AN UNSENT ROUND FOR THIS TABLE.
   *
   * CONDITION: the waiter session on this terminal has a non-empty basket built against this tab.
   * DETECTION: `unsentRoundLineCount > 0`, from ServiceSessionContext. Purely device-local — the
   * server has never heard of this round, and no other terminal can see it.
   * ALLOWING IT: throws away work the waiter has done and has no way to recover, on a table they
   * were mid-way through serving. Nothing anywhere warns them.
   *
   * FOUND IN THE CODE RATHER THAN BRIEFED. Listed for the owner alongside the rest.
   */
  {id: 'UNSENT_ROUND_ON_DEVICE', refuses: s => s.unsentRoundLineCount > 0},
];

/**
 * Every refusal that applies, in rule order. Empty means closeable.
 *
 * ALL rules are evaluated; there is no short-circuit. A waiter who fixes the first reason and is
 * then shown a second one they could have fixed on the same trip has been told the truth twice
 * instead of once.
 */
export function evaluateCloseTableRefusals(
  snapshot: CloseTableSnapshot,
): CloseTableRefusalId[] {
  return CLOSE_TABLE_REFUSAL_RULES.filter(rule => rule.refuses(snapshot)).map(
    rule => rule.id,
  );
}

/** Sugar over evaluateCloseTableRefusals. Never re-derives anything. */
export function canCloseTable(snapshot: CloseTableSnapshot): boolean {
  return evaluateCloseTableRefusals(snapshot).length === 0;
}

/**
 * The row for this table out of the whole tables payload.
 *
 * Pure, so the screen's fetch can be tested apart from its matching. Returns null rather than
 * undefined so it drops straight into the snapshot's nullable field, where rule 1 catches it.
 */
export function findTableRow(
  tables: TableWithTab[] | null | undefined,
  tableId: string,
): TableWithTab | null {
  if (!Array.isArray(tables)) {
    return null;
  }
  return tables.find(row => row.id === tableId) ?? null;
}
