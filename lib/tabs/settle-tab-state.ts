import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeTabOutstanding,
  TAB_TOTAL_ORDER_COLUMNS,
  type TabOrderRow,
} from './tab-outstanding'

/**
 * Take a tab OFF the ready-to-pay queue and, if it is still live, reopen it.
 *
 * TWO REASONS TO CALL THIS, and the second arrived on 2026-08-18. It was written for the first
 * and named after it, which is why the name says nothing about either:
 *
 *   1. MONEY WAS TAKEN against the tab. The queue entry has served its purpose.
 *   2. THE AMOUNT CHANGED under the queue entry -- a customer edited an order after pressing
 *      Ready to Pay. Staff must not settle at a figure that is no longer owed, so the tab leaves
 *      the queue and the customer presses the button again. See the call site in
 *      app/api/guest/orders/[orderId]/edit/route.ts for why that is gated on the total moving.
 *
 * Both want exactly the same two writes, including the split and the guard below, so they share
 * one implementation rather than growing a near-copy that drifts. The `logPrefix` is what tells
 * the two apart in the logs.
 *
 * Two statements, not one, and only the second is guarded. Both properties matter and they were
 * introduced independently:
 *
 * 1. SPLIT. These used to be a single UPDATE, so when the status write hit the one-open-tab-
 *    per-table unique index the whole statement failed and the ready-to-pay flags were never
 *    cleared, parking a fully paid tab on the ready-to-pay queue for good. Clearing the flags
 *    must therefore not depend on the status write succeeding -- so that one is deliberately
 *    NOT guarded on settled_at.
 *
 * 2. RESURRECTION GUARD. Reopening used to be unconditional. A tab closed via
 *    close_table_session carries status='settled' with settled_at/settled_type set; flipping it
 *    back to 'open' left a contradictory row and, far worse, re-armed the partial unique index
 *    idx_tabs_one_open_per_table UNIQUE (restaurant_id, table_number) WHERE status='open'
 *    (supabase/schema.sql:1797). With an 'open' row present a fresh insert for that table is
 *    impossible, so POST /api/tabs hits 23505 and silently degrades into a JOIN -- handing the
 *    NEXT customer the previous party's tab, complete with their name, itemised order and
 *    receipt, and bypassing the tab PIN because that path believes it is creating rather than
 *    joining.
 *
 *    The guard is `.is('settled_at', null)` in the statement itself rather than a JS check, so
 *    a close landing concurrently cannot slip through the window. A normal open or ready_to_pay
 *    tab has settled_at null and still reopens, which is the intended "settle, then keep
 *    ordering" behaviour.
 *
 * This lives in one place because it did not: the tab settle route was hardened while the
 * single-order terminal payment route kept the original fused, unguarded, unchecked write, and
 * that divergence is issue #123. Every caller that marks tab money as taken must use this.
 *
 * Never throws, and never fails its caller's request. Whichever reason brought it here, the thing
 * that mattered has already been recorded by the time this runs -- the payment, or the edit -- so
 * a tab-state write that cannot land is logged, not escalated. Telling a customer their change
 * failed because a queue flag would not clear would be a worse answer than a stale flag.
 */
export async function clearReadyToPayAndReopenTab(
  supabase: SupabaseClient,
  params: {
    tabId: string
    /** Purely for the log line, so the source route is identifiable. */
    logPrefix: string
    /**
     * Whether the tab had already been closed out (settled_at set) when the caller read it.
     * Only used to log that not reopening was expected rather than a failure. Omit if unknown --
     * the guard is enforced in the statement either way.
     */
     tabWasClosedOut?: boolean
    /**
     * WHICH OF THE TWO REASONS above brought us here. It decides whether the ready-to-pay RECORD
     * is preserved when money remains -- see the block below. Defaults to 'amount_changed', the
     * conservative choice: that reason always clears, which is exactly what every caller did
     * before this parameter existed.
     */
    reason?: 'money_taken' | 'amount_changed'
  },
): Promise<{ reopened: boolean; readyToPayPreserved: boolean }> {
  const { tabId, logPrefix, tabWasClosedOut, reason = 'amount_changed' } = params

  /**
   * #287. THE FIRST PARTIAL SETTLE USED TO WIPE THE SIGNAL FOR EVERYONE STILL WAITING.
   *
   * On a table of four who have all asked to pay, staff charging one diner's orders cleared
   * `ready_to_pay_at` for the whole tab. The terminal's chip disappeared and nobody was told the
   * other three were still waiting. Subset settlement is a first-class flow -- the terminal ships
   * a per-order multi-select -- so this stopped being theoretical.
   *
   * ONLY FOR reason 'money_taken'. An 'amount_changed' call MUST still clear: the customer edited
   * an order after pressing Ready to Pay, and the whole point is that staff must not settle at a
   * figure that is no longer owed. The customer presses the button again. Preserving the flag
   * there would reintroduce the defect that call site exists to fix.
   *
   * WHAT THIS DOES AND DOES NOT CHANGE. `status` is still reopened to 'open' exactly as before,
   * because status is the ORDERING GATE -- app/api/orders/route.ts refuses new orders on a
   * `ready_to_pay` tab, and the remaining diners must be able to keep ordering (spec Event L:
   * payment does not end the visit). So this has NO VISIBLE EFFECT TODAY: every consumer, the
   * terminal chip and app/menu/[restaurantId]/tab/page.tsx alike, keys on `status`.
   *
   * It is option C of the three on #287, and it is deliberately the half that ships without an
   * APK. What it buys is that the system stops DESTROYING the information: "someone at this table
   * asked to pay and money remains" is `ready_to_pay_at IS NOT NULL AND outstanding > 0`, and
   * once the record survives, option B -- surfacing that as a derived staff signal -- becomes a
   * pure render change in app/api/terminal/tables/route.ts plus a terminal build.
   *
   * UNTIL THAT APK SHIPS, STAFF STILL LOSE THE CHIP after the first partial settle. That is not
   * fixed here and is not claimed to be.
   *
   * FAILS TOWARD CLEARING. If the outstanding read errors, the flags are cleared as before. A
   * stale ready-to-pay flag on a fully paid tab is the older, worse defect (it parks a paid tab
   * on the queue for good), so an unknown answer takes the historical behaviour.
   */
  let preserveReadyToPay = false
  if (reason === 'money_taken') {
    const { data: remainingRows, error: remainingError } = await supabase
      .from('orders')
      .select(TAB_TOTAL_ORDER_COLUMNS)
      .eq('tab_id', tabId)

    if (remainingError) {
      console.error(`${logPrefix} could not read remaining balance; clearing flags as before`, {
        tabId,
        error: remainingError,
      })
    } else {
      const outstanding = computeTabOutstanding(remainingRows as TabOrderRow[])
      preserveReadyToPay = outstanding > 0
      console.log(`${logPrefix} post-settle balance`, { tabId, outstanding, preserveReadyToPay })
    }
  }

  if (!preserveReadyToPay) {
    const { error: clearFlagsError } = await supabase
      .from('tabs')
      .update({ payment_preference: null, ready_to_pay_at: null })
      .eq('id', tabId)

    if (clearFlagsError) {
      console.error(`${logPrefix} clearing ready-to-pay flags failed`, clearFlagsError)
    }
  }

  const { error: reopenError } = await supabase
    .from('tabs')
    .update({ status: 'open' })
    .eq('id', tabId)
    .is('settled_at', null)

  if (reopenError) {
    console.error(`${logPrefix} failed to reopen tab`, { tabId, error: reopenError })
    return { reopened: false, readyToPayPreserved: preserveReadyToPay }
  }

  if (tabWasClosedOut) {
    // Not an error: the payment is fully recorded. The tab was closed out, so it stays closed
    // and the table remains free for the next party.
    console.log(`${logPrefix} tab already closed out — not reopening`, { tabId })
    return { reopened: false, readyToPayPreserved: preserveReadyToPay }
  }

  return { reopened: true, readyToPayPreserved: preserveReadyToPay }
}
