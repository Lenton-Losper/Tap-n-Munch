/**
 * #216 — A TABLE WITH A LIVE TAB AND A NON-'occupied' STATUS IS INVISIBLE TO THE PAYMENT TERMINAL.
 *
 * `app/api/terminal/tables/route.ts:73` gates the terminal's ENTIRE table list:
 *
 *     .eq('status', 'occupied')
 *     .in('tabs.status', ['open', 'ready_to_pay'])     // on a tabs!inner join
 *
 * INNER join, so a table appears only when BOTH hold. A table holding a live tab whose
 * `restaurant_tables.status` is not `'occupied'` is absent from the device, and staff cannot take
 * payment on it. That is the expensive direction: a customer wanting to pay, and a terminal that
 * cannot see the table.
 *
 * ============================================================================================
 * THIS FILE FIXES THE WRITER, NOT THE READER — and that choice is the point
 * ============================================================================================
 *
 * #216 offers two fix directions, and BOTH are changes to what the terminal reads:
 *   "immediate" — drop `.eq('status','occupied')` and let the join gate it alone
 *   "real"      — stop storing the column and derive it
 *
 * Neither is taken here. Dropping the filter WIDENS what the device shows, which is a rule-7
 * change needing its own enumeration, and `__tests__/terminal-tables-gated-on-table-status.test.ts`
 * (commit `069b42d`) pins the current coupling by design so that any edit to that line announces
 * itself. That test is a recorded decision. Deriving the column is a larger question again.
 *
 * There is a third option the issue does not list, and it needs no ruling at all: MAKE THE COLUMN
 * TRUE. If every path that puts a customer on a live tab marks the table occupied, the invisible
 * state stops being reachable and the reader can be argued about later, calmly. Nothing a customer
 * sees changes; nothing the terminal shows changes except that tables which SHOULD have been there
 * now are.
 *
 * ============================================================================================
 * WHAT WAS ACTUALLY WRONG WITH THE WRITER — three separate faults, one column
 * ============================================================================================
 *
 * 1. THE ONE LIVE WRITER DISCARDED ITS RESULT.
 *        await supabase.from('restaurant_tables').update({ status: 'occupied' }).eq('id', ...)
 *    No destructure, so no error was ever read. A PostgREST error arrives in the RESOLVED object
 *    rather than as a throw, so this could not fail loudly even in principle — the same shape that
 *    made #201's deleted Confirm Payment handler run its success path unconditionally.
 *
 * 2. TWO OF THE THREE WAYS ONTO A TAB NEVER CALLED IT.
 *    - `app/api/tabs/route.ts` 23505 recovery branch returns `joinedExisting: true` BEFORE
 *      reaching the write.
 *    - `app/api/tabs/[tabId]/join/route.ts` never touched `restaurant_tables` at all.
 *    Both hand out a working session token for a live tab. Only the create path marked the table.
 *
 * 3. THE COLUMN'S RESETTER IS IN PLPGSQL, so a TypeScript grep finds the writes and the read but
 *    not the reset (`close_table_session`, baseline.sql:98-102, "mark table available"). The
 *    column reads as orphaned and one-way when it is neither, which is the defect's habitat rather
 *    than a footnote to it.
 *
 * ============================================================================================
 * WHY A FAILURE HERE DOES NOT FAIL THE REQUEST
 * ============================================================================================
 *
 * By the time this is called the customer HAS a tab and a session token. Refusing the request
 * would take a working tab away from someone sitting at a table, to fix a staff-side visibility
 * problem they cannot see and did not cause. So the failure is LOUD IN THE LOG and returned to the
 * caller for its own logging, and the request continues.
 *
 * That is a deliberate trade, not an oversight, and it is the reason the log line names the
 * consequence in words rather than printing an error object: whoever reads it needs to know a
 * TABLE IS INVISIBLE ON THE TERMINAL, not that an update returned a code.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type MarkTableOccupiedResult = {
  ok: boolean
  /** The PostgREST error, when there was one. Null on success and on a skipped no-op. */
  error: unknown
  /** True when there was no table id to mark — not a failure, and not a success either. */
  skipped: boolean
}

export async function markTableOccupied(
  supabase: SupabaseClient,
  tableId: string | null | undefined,
  /** Which path is calling, so the log says where to look. */
  logPrefix: string,
): Promise<MarkTableOccupiedResult> {
  const id = String(tableId ?? '').trim()
  if (!id) {
    // A kiosk tab, or a tab whose table_id was never set. Nothing to mark, and nothing wrong.
    return { ok: false, error: null, skipped: true }
  }

  const { error } = await supabase
    .from('restaurant_tables')
    .update({ status: 'occupied' })
    .eq('id', id)

  if (error) {
    console.error(
      `${logPrefix} could not mark the table occupied — THIS TABLE WILL BE INVISIBLE ON THE ` +
        'PAYMENT TERMINAL until it is closed and reopened, and staff will not be able to take ' +
        'payment on it from the device (#216)',
      { tableId: id, error },
    )
    return { ok: false, error, skipped: false }
  }

  return { ok: true, error: null, skipped: false }
}
