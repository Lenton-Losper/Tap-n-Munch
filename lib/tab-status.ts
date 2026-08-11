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
