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

/**
 * ============================================================================================
 * A SECOND SET OF BANDS, FOR THE OTHER CLOCK — AND THIS IS A DECISION THE OWNER SHOULD RULE ON
 * ============================================================================================
 *
 * The bands above answer "how long has this PLATE been sitting on the pass". They were authored
 * for that clock and they are right for it: five minutes is a long time for cooked food to wait.
 *
 * The wall board now carries colour on OUTSTANDING table cards too — twenty tables tiled across a
 * 1920x1080 screen, where a cook has to pick the one that needs hands without reading twenty
 * numbers. That means colouring a second clock: how long the kitchen has HAD the ticket.
 *
 * Reusing readyToRunEscalation for it would re-break the defect that was just fixed. A steak takes
 * eleven honest minutes; under the 0-2/3-5/5+ bands every outstanding card on a busy board goes red
 * inside six minutes and the colour stops carrying information — which is exactly what the owner
 * photographed on 2026-08-28.
 *
 * So the outstanding clock gets its own, slower bands. NOTHING IN THE BRIEF RULED THESE NUMBERS.
 * They are a first cut, chosen so that:
 *   - a dish still cooking at a normal pace (under ten minutes) is not shouted about;
 *   - a ticket the kitchen has held for twenty minutes with nothing plated is red, because in any
 *     restaurant that is a table asking where their food is;
 *   - past STALE_MINUTES the SAME quiet treatment applies as on the pass side, for the same
 *     reason: at that age it is orphaned, not urgent, and red should mean hands-now.
 * They are named constants so the owner can move them without hunting through a component.
 */
export const OUTSTANDING_AMBER_MINUTES = 10
export const OUTSTANDING_RED_MINUTES = 20

export function outstandingEscalation(minutes: number): AgeEscalation {
  if (minutes >= STALE_MINUTES) return 'stale'
  if (minutes < OUTSTANDING_AMBER_MINUTES) return 'white'
  if (minutes < OUTSTANDING_RED_MINUTES) return 'amber'
  return 'red'
}

/**
 * How loud each tier is, for picking a CARD's colour from the lines inside it.
 *
 * 'stale' sits BELOW 'white' deliberately. It is the quietest thing on the board (see the kitchen
 * screen's ESCALATION_CLASSES), so a card holding one abandoned line and one live one must read as
 * the live one — otherwise a four-hour-old orphan would grey out a table that needs hands now.
 */
const ESCALATION_LOUDNESS: Record<AgeEscalation, number> = { stale: 0, white: 1, amber: 2, red: 3 }

/** The loudest tier in a card. Empty means nothing to shout about — 'white'. */
export function worstEscalation(escalations: AgeEscalation[]): AgeEscalation {
  let worst: AgeEscalation = 'white'
  let seenAny = false
  for (const escalation of escalations) {
    if (!seenAny) {
      worst = escalation
      seenAny = true
      continue
    }
    if (ESCALATION_LOUDNESS[escalation] > ESCALATION_LOUDNESS[worst]) worst = escalation
  }
  return worst
}
