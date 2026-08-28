/**
 * feat/station-screens-v1 — age and escalation, pure functions.
 *
 * READY TO RUN is "the loudest thing on the screen" per the brief: white 0-2min, amber 3-5,
 * red 5+, oldest first — the kitchen's Ready zone still uses these bands directly
 * (readyToRunEscalation).
 *
 * FOUR ESCALATION FUNCTIONS NOW, ONE PER (BOARD, ZONE) PAIR THAT AGES ON ITS OWN CLOCK:
 * outstandingEscalation (kitchen active/outstanding), readyToRunEscalation (kitchen active/cooked
 * AND kitchen ready), barActiveEscalation (bar TO MAKE), barReadyEscalation (bar Waiting for
 * collection). The bar was originally ruled to carry no escalation at all — "a warm beer is a
 * smaller problem than a cold steak" — and that ruling was walked back at real volume (20260829):
 * the STAKES argument still holds, which is why the bar's own two functions use later bands than
 * their kitchen counterparts, but "lower stakes" stopped meaning "no colour" once a bartender had
 * to read twelve identical white cards to find the oldest one.
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

/** Same clock as ageMinutes, second-resolution — for formatElapsedClock's MM:SS. */
export function ageSeconds(sinceIso: string, now: number = Date.now()): number {
  const since = new Date(sinceIso).getTime()
  if (!Number.isFinite(since)) return 0
  return Math.max(0, Math.floor((now - since) / 1000))
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

/**
 * BOARD REDESIGN, SECOND PASS (20260829) — "elapsed stays small and consistent as MM:SS. Border
 * and accent intensity carry urgency, not giant red numbers." This is deliberately a DIFFERENT
 * function from formatAge above, not a replacement of it: formatAge's unit-scaling ("just now" /
 * "Xh Ym" / "Nd") is what the defect-1 fix pinned, and other places may still want that reading.
 * This board's dense grid wants a fixed-width, glanceable stopwatch instead.
 *
 * Minutes are NOT capped at 59 — a genuinely 2+ hour ticket reads "127:45", not "2:07:45" or a
 * wrapped "07:45". That is still "small and consistent" in FORMAT even when the number itself
 * gets long, and by the time a card is that old it has sunk to 'stale' (the quietest tier, see
 * worstEscalation) and nobody is reading its exact age closely anyway.
 */
export function formatElapsedClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(clamped / 60)
  const seconds = clamped % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
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
 * ============================================================================================
 * A THIRD SET OF BANDS — THE BAR'S TO MAKE ZONE, REVERSED 20260829 (the board rebuild's own
 * ruling walked back at real volume, not the original brief)
 * ============================================================================================
 *
 * "A warm beer is a smaller problem than a cold steak" was ruled when the bar board held four
 * cards and every one of them was the same colour — reading twelve numbers to find the oldest
 * costs nothing at four. Owner, walking the rebuilt board at real volume: "at twelve it costs
 * more than it saves" — a bartender had to read every table number in turn, because colour,
 * which is what the kitchen board uses to shortcut exactly that read, was switched off here on
 * purpose. So TO MAKE ages now, on the same four-tier language as everything else on either
 * board.
 *
 * THE THRESHOLDS ARE LATER THAN THE KITCHEN'S, DELIBERATELY, PER THE SAME RULING THAT REVERSED
 * THE REST OF IT: a warm beer is still a smaller problem than a cold steak, so a bar round should
 * not go amber and red on the kitchen's clock. NOTHING HAS MEASURED THESE NUMBERS — same posture
 * as OUTSTANDING_AMBER_MINUTES/OUTSTANDING_RED_MINUTES above: a first cut, roughly 1.5x the
 * kitchen's outstanding bands, named so they can be moved without hunting through a component
 * once real service has an opinion.
 */
export const BAR_ACTIVE_AMBER_MINUTES = 15
export const BAR_ACTIVE_RED_MINUTES = 30

export function barActiveEscalation(minutes: number): AgeEscalation {
  if (minutes >= STALE_MINUTES) return 'stale'
  if (minutes < BAR_ACTIVE_AMBER_MINUTES) return 'white'
  if (minutes < BAR_ACTIVE_RED_MINUTES) return 'amber'
  return 'red'
}

/**
 * ============================================================================================
 * A FOURTH SET OF BANDS — BAR'S READY (WAITING FOR COLLECTION) ZONE, SOFTER THAN THE KITCHEN'S
 * ============================================================================================
 *
 * Second-pass redesign, 20260829: "bar ready ages and sorts but escalates more softly than
 * kitchen. The consequence of a waiting drink is lower than a waiting plate." This SUPERSEDES the
 * first pass's choice to share readyToRunEscalation's bands (2/5) between both boards' Ready
 * zones — that was the same "one set of stakes for two different stakes" mistake the original
 * "bar stays neutral" ruling made for TO MAKE, just in the other zone. A cold plate is still a
 * worse consequence than a warm drink even once both are sitting made; the bands should say so.
 *
 * UNMEASURED, same posture as every other first-cut band in this file: roughly 2.5x the kitchen
 * ready bands, softer than even bar's own TO MAKE bands above (a drink already poured and waiting
 * is more urgent than one not yet started, so ready should still escalate FASTER than active for
 * the same board — 5/15 here vs 15/30 for TO MAKE).
 */
export const BAR_READY_AMBER_MINUTES = 5
export const BAR_READY_RED_MINUTES = 15

export function barReadyEscalation(minutes: number): AgeEscalation {
  if (minutes >= STALE_MINUTES) return 'stale'
  if (minutes < BAR_READY_AMBER_MINUTES) return 'white'
  if (minutes < BAR_READY_RED_MINUTES) return 'amber'
  return 'red'
}

/**
 * How loud each tier is, for picking a CARD's colour from the lines inside it.
 *
 * 'stale' sits BELOW 'white' deliberately. It is the quietest thing on the board (see the kitchen
 * screen's ESCALATION_CLASSES), so a card holding one abandoned line and one live one must read as
 * the live one — otherwise a four-hour-old orphan would grey out a table that needs hands now.
 */
/**
 * EXPORTED (20260829160000) for the board rebuild's own sort — "FIFO by default, but overdue
 * rises visually" is read literally: a round's POSITION, not only its colour, moves when its
 * escalation is louder than its neighbours'. Same ranking worstEscalation already used to pick a
 * card's colour; sorting by it too means a round cannot be the loudest colour on the board and
 * still sit below three quieter ones.
 */
export const ESCALATION_RANK: Record<AgeEscalation, number> = { stale: 0, white: 1, amber: 2, red: 3 }

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
    if (ESCALATION_RANK[escalation] > ESCALATION_RANK[worst]) worst = escalation
  }
  return worst
}

/**
 * "FIFO by default, but overdue rises visually" (the board rebuild, 20260829160000) — a louder
 * round moves ABOVE quieter ones regardless of when it landed; within the same tier, the one
 * that has waited longest still comes first, which is what makes it read as FIFO at a glance
 * rather than as a shuffled board. 'stale' ranks below 'white' (see ESCALATION_RANK), so an
 * abandoned round sinks rather than crowding out one that still needs hands.
 */
export function sortByUrgency<T>(
  items: T[],
  escalationOf: (item: T) => AgeEscalation,
  clockMsOf: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    const rankDiff = ESCALATION_RANK[escalationOf(b)] - ESCALATION_RANK[escalationOf(a)]
    if (rankDiff !== 0) return rankDiff
    return clockMsOf(a) - clockMsOf(b)
  })
}
