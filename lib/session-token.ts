import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isTabSessionEndedStatus } from '@/lib/tab-status'

type SupabaseServerClient = ReturnType<typeof createServerSupabaseClient>

export async function issueSessionToken({
  tabId,
  tableId,
  restaurantId,
  sessionVersion,
}: {
  tabId: string
  tableId: string
  restaurantId: string
  sessionVersion: number
}): Promise<string> {
  const supabase = createServerSupabaseClient()

  const token = crypto.randomUUID()
  console.log('[TOKEN-1] generated token', token)

  const { error } = await supabase.from('customer_sessions').insert({
    token,
    tab_id: tabId,
    table_id: tableId,
    restaurant_id: restaurantId,
    session_version: sessionVersion,
    active: true,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  })

  console.log('[TOKEN-2] insert error', error)
  console.log('[TOKEN-2] returning token', token)
  if (error) throw new Error(`Failed to issue session token: ${error.message}`)
  return token
}

export async function issueTokenForOpenTab(
  supabase: SupabaseServerClient,
  tabId: string,
  tableId: string,
  restaurantId: string
): Promise<string> {
  const { data: tableData, error: tableError } = await supabase
    .from('restaurant_tables')
    .select('current_session_version')
    .eq('id', tableId)
    .single()

  if (tableError) {
    throw new Error(`Failed to load table session version: ${tableError.message}`)
  }

  const sessionVersion = tableData?.current_session_version ?? 1

  const { error: tabUpdateError } = await supabase
    .from('tabs')
    .update({ session_version: sessionVersion })
    .eq('id', tabId)

  if (tabUpdateError) {
    throw new Error(`Failed to update tab session version: ${tabUpdateError.message}`)
  }

  const result = await issueSessionToken({
    tabId,
    tableId,
    restaurantId,
    sessionVersion,
  })
  console.log('[TOKEN-3] issueTokenForOpenTab returning', result)
  return result
}

export async function validateSessionToken(token: string): Promise<{
  valid: boolean
  reason?: string
  tabId?: string
  tableId?: string
  restaurantId?: string
  /**
   * The tab's status, as this function already read it through the `tabs!inner` join.
   *
   * RETURNED RATHER THAN RE-QUERIED so callers that need to branch on it -- the guest edit route
   * refuses an addition to a tab that is no longer `open` (#301) -- use the SAME row this
   * validation used. A second `select` would be a second point in time, and the two could disagree
   * across a settle landing between them.
   */
  tabStatus?: string
}> {
  const supabase = createServerSupabaseClient()

  const { data: session, error } = await supabase
    .from('customer_sessions')
    .select(`
      id,
      tab_id,
      table_id,
      restaurant_id,
      session_version,
      active,
      expires_at,
      tabs!inner (status),
      restaurant_tables!inner (current_session_version)
    `)
    .eq('token', token)
    .single()

  if (error || !session) {
    return { valid: false, reason: 'Session not found' }
  }

  if (!session.active) {
    return { valid: false, reason: 'Session has been revoked' }
  }

  if (new Date(session.expires_at) < new Date()) {
    return { valid: false, reason: 'Session has expired' }
  }

  /**
   * ASKING TO PAY MUST NOT END THE SESSION. RULED 2026-08-26.
   *
   * This used to read `tab.status !== 'open'`, which made `ready_to_pay` an invalid session — so
   * the moment a customer tapped Settle and chose a method, `/api/tabs/[tabId]/ready-to-pay` set
   * `tabs.status = 'ready_to_pay'` and their OWN button invalidated their session. The /tab screen
   * polls every 5s through `fetchWithSession`, which calls `handleSessionExpired` itself on a 410,
   * so within one tick the token, the tab id, the table and the CART were cleared and the phone was
   * replaced onto /session-ended. They had paid nothing.
   *
   * Measured on production: the two customer_sessions on the tab stuck in ready_to_pay were
   * `active`, unexpired, and version-correct. Every other validity condition passed. The only
   * failing one was the status the customer had just set.
   *
   * `ready_to_pay` is a REQUEST for staff to come and take money. Requested is not paid, and paid
   * is not closed. `ACTIVE_TAB_STATUSES` has said `['open', 'ready_to_pay']` all along — this
   * function simply did not use the vocabulary, and hard-coded a narrower one.
   *
   * NOW A DENYLIST: only settled / closed / completed / cancelled end a session. See
   * `isTabSessionEndedStatus` for why an unrecognised status must not evict a customer mid-meal.
   * Cross-tenant safety on this path is the session VERSION check immediately below and the
   * restaurant scoping around it — never the status.
   */
  const tab = Array.isArray(session.tabs) ? session.tabs[0] : session.tabs
  if (!tab || isTabSessionEndedStatus(tab.status)) {
    return { valid: false, reason: 'Tab is no longer open' }
  }

  const table = Array.isArray(session.restaurant_tables)
    ? session.restaurant_tables[0]
    : session.restaurant_tables

  if (!table || table.current_session_version !== session.session_version) {
    return { valid: false, reason: 'Session version mismatch — table has been reset' }
  }

  return {
    valid: true,
    tabId: session.tab_id,
    tableId: session.table_id,
    restaurantId: session.restaurant_id,
    tabStatus: String(tab.status ?? ''),
  }
}
