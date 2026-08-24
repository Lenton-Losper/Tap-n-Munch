import { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * #333 — close tabs that have been abandoned, so the table can be used again.
 *
 * WHAT THIS IS NOT. It is not a session expiry. Sessions already expire: `issueSessionToken` sets
 * `customer_sessions.expires_at` to now()+24h and `validateSessionToken` enforces it on every
 * token-guarded route, POST /api/orders included. #333 states there is no TTL; there is one, and
 * it works. What has never ended is the TAB — `status` stays 'open' forever, which keeps
 * `idx_tabs_one_open_per_table` armed and routes the next customer who scans that table down the
 * 23505 branch in app/api/tabs/route.ts — and the TABLE, whose `status` stays 'occupied'.
 *
 * ALL OF THE JUDGEMENT LIVES IN SQL, in `reap_abandoned_tab`. This module only supplies candidate
 * ids. It cannot decide that a tab is idle, and it cannot decide that a tab is safe to close: the
 * function re-derives both and refuses if either is wrong. That split is deliberate. A tab that
 * owes money must never be settled by a cron, because `settled_type` means a human closed it, and
 * a selection bug here would otherwise become a fabricated settlement. Putting the guard where the
 * write happens makes that failure unexpressible rather than merely unlikely.
 *
 * The threshold is passed to the function, which validates it too — a caller cannot ask for 0.
 */

/** Hours of evidenced inactivity before a tab is considered abandoned. See the migration for what "activity" means and what it cannot see. */
export const ABANDONED_TAB_INACTIVE_HOURS = 4

/** Bounded per tick. A backlog drains over successive runs rather than in one long transaction. */
export const REAP_BATCH_LIMIT = 200

export type ReapAbandonedTabsResult = {
  candidates: number
  reaped: number
  reapedTabIds: string[]
  leftForStaff: number
  leftForStaffTabIds: string[]
  stillActive: number
  errors: number
  /** True when the candidate list hit the batch cap, so more remain for the next tick. */
  truncated: boolean
}

export async function reapAbandonedTabs(
  supabase: Supabase,
  inactiveHours: number = ABANDONED_TAB_INACTIVE_HOURS,
): Promise<ReapAbandonedTabsResult> {
  const result: ReapAbandonedTabsResult = {
    candidates: 0,
    reaped: 0,
    reapedTabIds: [],
    leftForStaff: 0,
    leftForStaffTabIds: [],
    stillActive: 0,
    errors: 0,
    truncated: false,
  }

  // Only an upper bound on staleness is applied here, and only to keep the candidate list small.
  // It is not the decision — `reap_abandoned_tab` re-derives last activity from orders, requests
  // and sessions, any one of which can be newer than the tab row itself.
  const cutoff = new Date(Date.now() - inactiveHours * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('tabs')
    .select('id')
    .eq('status', 'open')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(REAP_BATCH_LIMIT)

  if (error) throw new Error(`reapAbandonedTabs: candidate query failed: ${error.message}`)

  const candidates = (data ?? []).map((row) => String((row as { id: string }).id))
  result.candidates = candidates.length
  result.truncated = candidates.length === REAP_BATCH_LIMIT

  for (const tabId of candidates) {
    const { data: outcome, error: rpcError } = await supabase.rpc('reap_abandoned_tab', {
      p_tab_id: tabId,
      p_inactive_hours: inactiveHours,
    })

    if (rpcError) {
      // One tab failing must not stop the rest; a stuck row would otherwise block every later tab
      // on every future tick.
      result.errors++
      console.error('[REAP-TABS] failed for tab', tabId, rpcError.message)
      continue
    }

    const reaped = (outcome as { reaped?: boolean } | null)?.reaped === true
    const reason = String((outcome as { reason?: string } | null)?.reason ?? '')

    if (reaped) {
      result.reaped++
      result.reapedTabIds.push(tabId)
    } else if (reason === 'money_or_review_outstanding') {
      result.leftForStaff++
      result.leftForStaffTabIds.push(tabId)
    } else {
      result.stillActive++
    }
  }

  return result
}
