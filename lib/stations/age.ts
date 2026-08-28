/**
 * feat/station-screens-v1 — age and escalation, pure functions.
 *
 * READY TO RUN is "the loudest thing on the screen" per the brief: white 0-2min, amber 3-5,
 * red 5+, oldest first. The BAR side deliberately has no escalation — "a warm beer is a smaller
 * problem than a cold steak" — so bar age is display-only and always uses `neutral`.
 */

export type AgeEscalation = 'white' | 'amber' | 'red' | 'stale'

/**
 * Past this, a card is not urgent — it is abandoned, and saying "act now" about it is a lie.
 *
 * WHY A FOURTH TIER EXISTS AT ALL. Owner walked the board 2026-08-28: *"Every cooked card is red
 * including the 88-minute one. The escalation is not discriminating."* With only three tiers the
 * top one is unbounded, so a card at 6 minutes and a card at nine days are the same colour. Red
 * then stops meaning anything, and the one card that genuinely needs a cook's hands is hidden in a
 * wall of identical red.
 *
 * Four hours is past the end of any service. A line still sitting cooked at that age was not
 * missed — it was orphaned by a crash, a fixture, or a tab nobody closed, and the answer is
 * somebody clearing it, not a cook running faster.
 */
export const STALE_MINUTES = 240

export function ageMinutes(sinceIso: string, now: number = Date.now()): number {
  const since = new Date(sinceIso).getTime()
  if (!Number.isFinite(since)) return 0
  return Math.max(0, Math.floor((now - since) / 60_000))
}

/**
 * white 0-2, amber 3-5, red 5+. The boundaries are inclusive on the low side of each band —
 * minute 2 is still white, minute 3 opens amber, minute 6 opens red — read directly off the
 * brief's "0-2min, 3-5, 5+" rather than re-derived. THESE BANDS ARE UNCHANGED: they were right,
 * and the defect the owner saw was the CLOCK being fed into them, not the numbers themselves.
 */
export function readyToRunEscalation(minutes: number): AgeEscalation {
  if (minutes >= STALE_MINUTES) return 'stale'
  if (minutes <= 2) return 'white'
  if (minutes <= 5) return 'amber'
  return 'red'
}

/**
 * Human age for a wall board read at 3m.
 *
 * `${n} min` unbounded produced "12877 min" on a real card — nine days in raw minutes, which the
 * owner correctly called unreadable. Nobody divides by 1440 at a glance across a kitchen.
 *
 * Units change as the number stops being countable: minutes below an hour, hours-and-minutes below
 * a day, whole days past that. "9d" is the owner's own wording for the last case.
 */
export function formatAge(minutes: number): string {
  if (minutes <= 0) return 'just now'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const remainder = minutes % 60
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
  }

  return `${Math.floor(hours / 24)}d`
}

/** Oldest first — the line that has waited longest is the one a waiter should see first. */
export function sortOldestFirst<T>(items: T[], sinceIso: (item: T) => string): T[] {
  return [...items].sort((a, b) => new Date(sinceIso(a)).getTime() - new Date(sinceIso(b)).getTime())
}
