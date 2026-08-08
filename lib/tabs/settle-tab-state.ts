import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Bring a tab's state back in line after money has been taken against it.
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
 * Never throws, and never fails its caller's request: the payment is already recorded by the
 * time this runs, so a tab-state write that cannot land is logged, not escalated.
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
  },
): Promise<{ reopened: boolean }> {
  const { tabId, logPrefix, tabWasClosedOut } = params

  const { error: clearFlagsError } = await supabase
    .from('tabs')
    .update({ payment_preference: null, ready_to_pay_at: null })
    .eq('id', tabId)

  if (clearFlagsError) {
    console.error(`${logPrefix} clearing ready-to-pay flags failed`, clearFlagsError)
  }

  const { error: reopenError } = await supabase
    .from('tabs')
    .update({ status: 'open' })
    .eq('id', tabId)
    .is('settled_at', null)

  if (reopenError) {
    console.error(`${logPrefix} failed to reopen tab`, { tabId, error: reopenError })
    return { reopened: false }
  }

  if (tabWasClosedOut) {
    // Not an error: the payment is fully recorded. The tab was closed out, so it stays closed
    // and the table remains free for the next party.
    console.log(`${logPrefix} tab already closed out — not reopening`, { tabId })
    return { reopened: false }
  }

  return { reopened: true }
}
