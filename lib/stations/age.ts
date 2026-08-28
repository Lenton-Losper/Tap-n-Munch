/**
 * feat/station-screens-v1 — age and escalation, pure functions.
 *
 * READY TO RUN is "the loudest thing on the screen" per the brief: white 0-2min, amber 3-5,
 * red 5+, oldest first. The BAR side deliberately has no escalation — "a warm beer is a smaller
 * problem than a cold steak" — so bar age is display-only and always uses `neutral`.
 */

export type AgeEscalation = 'white' | 'amber' | 'red'

export function ageMinutes(sinceIso: string, now: number = Date.now()): number {
  const since = new Date(sinceIso).getTime()
  if (!Number.isFinite(since)) return 0
  return Math.max(0, Math.floor((now - since) / 60_000))
}

/**
 * white 0-2, amber 3-5, red 5+. The boundaries are inclusive on the low side of each band —
 * minute 2 is still white, minute 3 opens amber, minute 6 opens red — read directly off the
 * brief's "0-2min, 3-5, 5+" rather than re-derived.
 */
export function readyToRunEscalation(minutes: number): AgeEscalation {
  if (minutes <= 2) return 'white'
  if (minutes <= 5) return 'amber'
  return 'red'
}

/** Oldest first — the line that has waited longest is the one a waiter should see first. */
export function sortOldestFirst<T>(items: T[], sinceIso: (item: T) => string): T[] {
  return [...items].sort((a, b) => new Date(sinceIso(a)).getTime() - new Date(sinceIso(b)).getTime())
}
