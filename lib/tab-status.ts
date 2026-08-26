/**
 * Tab status vocabulary, with no imports.
 *
 * Split out of lib/tab-session.ts so server code can use it. lib/tab-session.ts imports
 * lib/supabase/client.ts, which constructs a *browser* Supabase client at module scope --
 * importing it from an API route would run that inside the Worker. Re-exported from
 * lib/tab-session.ts so every existing import site keeps working unchanged.
 */

export const ACTIVE_TAB_STATUSES = ['open', 'ready_to_pay'] as const

export function isActiveTabStatus(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return ACTIVE_TAB_STATUSES.includes(s as (typeof ACTIVE_TAB_STATUSES)[number])
}

/**
 * A tab whose dining session is genuinely OVER.
 *
 * RULED 2026-08-26: asking to pay must not end the session. `ready_to_pay` is a customer asking
 * staff to come and take money — requested is not paid, and paid is not closed. Only these four
 * mean the session is finished.
 *
 * MOVED HERE FROM lib/tab-session.ts, unchanged, for the reason at the top of this file: that
 * module constructs a browser Supabase client at import time, so a server module cannot use its
 * copy. `validateSessionToken` needed exactly this predicate and, lacking a server-safe one,
 * hard-coded `status !== 'open'` instead — which invalidated the session of every customer who
 * pressed Settle. lib/tab-session.ts now re-exports this one, so there is a single definition.
 *
 * A DENYLIST, DELIBERATELY, AND NOT `!isActiveTabStatus`. An unrecognised status must not evict a
 * customer who is in the middle of a meal: the failure mode being fixed here IS eviction, and a
 * status this vocabulary has not heard of is not evidence that the party has left. The same
 * reasoning is already recorded on `cashReadyToPayRefusal`, which uses `isTerminalOrderStatus`
 * rather than `!isActiveOrderStatus` so that "an unrecognised status must not refuse a customer who
 * is genuinely waiting to pay".
 *
 * Nothing is weakened by that choice: cross-tenant safety on this path comes from the session
 * VERSION check and the restaurant scoping beside it, not from the status.
 */
export const TAB_SESSION_ENDED_STATUSES = ['settled', 'closed', 'completed', 'cancelled'] as const

export function isTabSessionEndedStatus(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return TAB_SESSION_ENDED_STATUSES.includes(s as (typeof TAB_SESSION_ENDED_STATUSES)[number])
}
