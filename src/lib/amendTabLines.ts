/**
 * AMENDING A LINE BEFORE THE KITCHEN STARTS IT.
 *
 * Every shape in this file was read off the server, not inferred:
 *   app/api/terminal/tabs/[tabId]/amend/route.ts
 *   supabase/migrations/20260829150000_amend_order_lines_function.sql
 *
 * That mattered: this is the same class of work that produced `ready_to_run`, a state written by
 * the terminal against a vocabulary the database never accepted. The refusal strings below are
 * copied from the SQL function's own literals, not invented to look plausible.
 *
 * ================================================================================================
 * THE MODEL: VOID AND REPLACE, NEVER MUTATE
 * ================================================================================================
 *
 * A line is never edited in place. Reducing a quantity voids the line and adds a replacement; a
 * removal voids it with no replacement. The kitchen therefore sees a line DISAPPEAR rather than
 * silently change under them mid-prep.
 *
 * The replacement lands on a NEW ORDER on the same tab, so `orders.items` is never rewritten and
 * the bill still sums. `order_id` / `order_number` in the response identify that new order, and
 * are NULL when nothing survived the window (every line refused — so there was nothing to create).
 *
 * ================================================================================================
 * ONE CALL. THE HALF-APPLIED STATE CANNOT EXIST.
 * ================================================================================================
 *
 * The whole amendment is a single `amend_order_lines` transaction server-side. A voided line with
 * no replacement is food the customer ordered that nobody is making, so the void and the add can
 * never be separate requests. Do not "helpfully" retry a partial result by re-sending the lines
 * that came back refused: they were refused because the kitchen already has them.
 */
/**
 * TYPES AND PURE HELPERS ONLY. The request itself lives in lib/api.ts as `amendTabLines`,
 * alongside every other endpoint client, because `terminalFetch`, `parseApiError` and the base URL
 * are internal to that module. Exporting them just to reach them here would widen api.ts's surface
 * for one caller's convenience.
 *
 * Keeping the window rule and the result predicates out here is what lets them be unit-tested
 * without a fetch double.
 */

/** One requested change. `new_quantity: 0` means remove the line entirely. */
export interface LineAmendment {
  line_id: string;
  new_quantity: number;
}

/**
 * What the server DID to a line.
 *
 * 'voided'   — removed, no replacement (new_quantity was 0).
 * 'replaced' — voided, and `new_line_id` is the replacement carrying the new quantity.
 */
export interface AppliedAmendment {
  line_id: string;
  action: 'voided' | 'replaced';
  new_line_id?: string;
}

/**
 * Why a line was NOT changed. These strings are the SQL function's own literals — see migration
 * 20260829150000 — plus the two the Sprint 2026-09-28 contract (C3) adds. `AmendRefusalReason` is
 * deliberately a union of them plus `string`, so a reason this build has never heard of still
 * reaches the screen instead of being dropped.
 */
export type AmendRefusalReason =
  /** The line is already cooked or ready. The kitchen won; the amendment loses. */
  | 'window_closed'
  /** No such line on this tab at this venue. A stale screen, or somebody else already voided it. */
  | 'not_found'
  /** The quantity did not survive the function's own validation. */
  | 'invalid_quantity'
  /** C3. The order carrying the line is already paid. */
  | 'order_paid'
  /** C3. This line has been settled (split / pay-by-item). */
  | 'line_settled'
  | string;

export interface RefusedAmendment {
  line_id: string;
  reason: AmendRefusalReason;
}

export interface AmendResult {
  /** The NEW order carrying every replacement. Null when every line was refused. */
  order_id: string | null;
  order_number: number | null;
  applied: AppliedAmendment[];
  refused: RefusedAmendment[];
  /**
   * FALSE WHEN THE 200 COULD NOT BE READ AS AN AMEND RESULT: not JSON, not an object, or `applied`
   * / `refused` missing or not arrays. Such a body proves nothing either way, so it is NOT a
   * success and NOT a refusal — it is "not confirmed". Before Sprint 2026-09-28 the parser
   * defaulted missing arrays to [] and a body of `{}` read as a clean, quiet success.
   */
  well_formed: boolean;
  /** C3. Absent (undefined) on an older server; never inferred from `applied`. */
  changed?: boolean;
  lines?: AmendLineSummary[];
}

/** C3's per-line summary. Additive: an older server sends none, and nothing may depend on it. */
export interface AmendLineSummary {
  line_id: string;
  name: string | null;
  outcome: string;
  previous_quantity: number | null;
  quantity: number | null;
  refusal_reason?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The amend route's 200 body, read STRICTLY. Entries without a string line_id are dropped rather
 * than guessed at, and a body whose arrays are missing comes back with `well_formed: false`.
 */
export function parseAmendResult(data: unknown): AmendResult {
  if (!isObject(data) || !Array.isArray(data.applied) || !Array.isArray(data.refused)) {
    return {order_id: null, order_number: null, applied: [], refused: [], well_formed: false};
  }
  const applied: AppliedAmendment[] = data.applied
    .filter(isObject)
    .filter(row => typeof row.line_id === 'string' && row.line_id !== '')
    .map(row => ({
      line_id: String(row.line_id),
      action: row.action === 'replaced' ? ('replaced' as const) : ('voided' as const),
      ...(typeof row.new_line_id === 'string' ? {new_line_id: row.new_line_id} : {}),
    }));
  const refused: RefusedAmendment[] = data.refused
    .filter(isObject)
    .filter(row => typeof row.line_id === 'string' && row.line_id !== '')
    .map(row => ({line_id: String(row.line_id), reason: String(row.reason ?? '')}));
  const result: AmendResult = {
    order_id: typeof data.order_id === 'string' ? data.order_id : null,
    order_number: numberOrNull(data.order_number),
    applied,
    refused,
    well_formed: true,
  };
  if (typeof data.changed === 'boolean') {
    result.changed = data.changed;
  }
  if (Array.isArray(data.lines)) {
    result.lines = data.lines
      .filter(isObject)
      .filter(row => typeof row.line_id === 'string')
      .map(row => ({
        line_id: String(row.line_id),
        name: typeof row.name === 'string' ? row.name : null,
        outcome: String(row.outcome ?? ''),
        previous_quantity: numberOrNull(row.previous_quantity),
        quantity: numberOrNull(row.quantity),
        ...(typeof row.refusal_reason === 'string' ? {refusal_reason: row.refusal_reason} : {}),
      }));
  }
  return result;
}

/**
 * Whether a line may be amended at all, decided from the SERVER's own line state.
 *
 * Mirrors the window the SQL function enforces: outstanding at every station that owns the line.
 * This is an affordance only — the server decides, and it can refuse a line this returns true for,
 * because the kitchen may tap Cooked in the moment between the screen rendering and the waiter
 * pressing. That race is exactly why refusals come back per line.
 *
 * `is_ready` is NOT used here: a line can be past the window without being fully ready (one
 * station cooked, the other still outstanding), and treating ready as the only closed state would
 * offer an edit the server is certain to refuse.
 */
export function canAmendLine(line: {
  is_voided?: boolean;
  kitchen_state?: string | null;
  bar_state?: string | null;
}): boolean {
  if (line.is_voided) {
    return false;
  }

  const kitchenOpen = line.kitchen_state == null || line.kitchen_state === 'outstanding';
  const barOpen = line.bar_state == null || line.bar_state === 'outstanding';
  const hasAStation = line.kitchen_state != null || line.bar_state != null;

  return hasAStation && kitchenOpen && barOpen;
}

/**
 * True when nothing on the tab is CONFIRMED to have changed.
 *
 * CHANGED Sprint 2026-09-28: this used to be `applied empty AND refused non-empty`, and a test
 * asserted that an empty result "is not a refusal" — so a 200 of `{applied: [], refused: []}` read
 * as success. Riviera #160 is what that shape costs: a waiter believes an item is off and the
 * kitchen cooks it. Confirmation is now positive only — something must be IN `applied`.
 */
export function nothingApplied(result: AmendResult): boolean {
  return !result.well_formed || result.applied.length === 0;
}

// ================================================================================================
// WHAT THE WAITER IS TOLD ABOUT ONE LINE. (Sprint 2026-09-28 brief, contract C3.)
// ================================================================================================
//
// THE ONLY PATH TO "confirmed" IS THE LINE'S OWN id IN `applied`. Not the sheet closing, not a
// 200, not `changed: true`, not an entry in `lines`. `lines` only decorates a confirmation that
// `applied` already gave (the quantity the server actually left), and a line absent from both
// arrays is "not_confirmed" — the server did not say what happened to it.

export type LineAmendOutcome =
  | {
      kind: 'confirmed';
      lineId: string;
      /** removed: the line is gone. reduced / increased: it now stands at `quantity`. */
      effect: 'removed' | 'reduced' | 'increased';
      quantity: number;
      previousQuantity: number;
    }
  | {kind: 'refused'; lineId: string; reason: AmendRefusalReason}
  | {kind: 'not_confirmed'; lineId: string; why: 'malformed' | 'absent'};

export function lineAmendOutcome(
  result: AmendResult,
  request: {lineId: string; previousQuantity: number; requestedQuantity: number},
): LineAmendOutcome {
  const {lineId} = request;
  if (!result.well_formed) {
    return {kind: 'not_confirmed', lineId, why: 'malformed'};
  }
  const applied = result.applied.find(row => row.line_id === lineId);
  if (applied) {
    const summary = result.lines?.find(row => row.line_id === lineId);
    const quantity =
      applied.action === 'voided' ? 0 : summary?.quantity ?? request.requestedQuantity;
    const previousQuantity = summary?.previous_quantity ?? request.previousQuantity;
    return {
      kind: 'confirmed',
      lineId,
      effect: quantity === 0 ? 'removed' : quantity < previousQuantity ? 'reduced' : 'increased',
      quantity,
      previousQuantity,
    };
  }
  const refused = result.refused.find(row => row.line_id === lineId);
  if (refused) {
    return {kind: 'refused', lineId, reason: refused.reason};
  }
  return {kind: 'not_confirmed', lineId, why: 'absent'};
}

/**
 * The money a CONFIRMED reduction took off, for the sentence only, from the line's own server
 * total. Null when the server sent no price for the line — the sentence then names no figure
 * rather than inventing one. Never used to compute a bill.
 */
export function amountOffCents(
  lineTotalCents: number | null | undefined,
  previousQuantity: number,
  quantity: number,
): number | null {
  if (
    typeof lineTotalCents !== 'number' ||
    !Number.isFinite(lineTotalCents) ||
    previousQuantity <= 0 ||
    quantity >= previousQuantity
  ) {
    return null;
  }
  if (quantity <= 0) {
    return lineTotalCents;
  }
  return Math.round((lineTotalCents * (previousQuantity - quantity)) / previousQuantity);
}

