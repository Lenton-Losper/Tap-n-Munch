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
 * Why a line was NOT changed. These three strings are the SQL function's own literals — see
 * migration 20260829150000. `AmendRefusalReason` is deliberately a union of them plus `string`,
 * so a reason this build has never heard of still reaches the screen instead of being dropped.
 */
export type AmendRefusalReason =
  /** The line is already cooked or ready. The kitchen won; the amendment loses. */
  | 'window_closed'
  /** No such line on this tab at this venue. A stale screen, or somebody else already voided it. */
  | 'not_found'
  /** The quantity did not survive the function's own validation. */
  | 'invalid_quantity'
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

/** True when the whole amendment was refused — nothing changed on the tab. */
export function nothingApplied(result: AmendResult): boolean {
  return result.applied.length === 0 && result.refused.length > 0;
}

