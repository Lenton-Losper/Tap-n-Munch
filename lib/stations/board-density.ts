/**
 * lib/stations/board-density.ts — how many rounds go across the wall, and how big the type is.
 *
 * ============================================================================================
 * REBUILT 20260829160000 — THE CHROME WAS THE PROBLEM, NOT THE TEXT
 * ============================================================================================
 *
 * The first density rebuild (2026-08-28) fixed "two cards across a 1920x1080 wall" by scaling
 * type size and column count together. It did not fix "one round takes 300-500px" — a
 * `rounded-2xl` card with `border-8` and `px-5 py-4` around every table spent most of its own
 * height on box, not on food. Twenty tables at that scale is a scrolling wall screen even at the
 * densest tier, which is the defect this rebuild exists to close: "one round occupies a few
 * lines, not a card."
 *
 * So this keeps the text floors the roomy/standard/compact tiers already measured correct — 24px
 * is still where an item name at 3m stops being legible, and that number does not move just
 * because the board needs to hold more rounds — and cuts the SPACE AROUND the text instead:
 * thinner borders, tighter padding, no per-round vertical margin beyond what separates one round
 * from the next. The win comes from chrome, not from text nobody could read anyway.
 *
 * WHAT IS STILL NEVER TRADED AWAY: a line of food. No tier caps, truncates or hides a line, and
 * no tier collapses a table into a count.
 *
 * Measured, not asserted: tests/e2e/station-board-wall-fit.spec.ts renders a twenty-round fixture
 * at 1920x1080 in a real browser and fails if either zone's content exceeds its own bounds.
 */

export type BoardDensity = 'roomy' | 'standard' | 'compact'

export type DensityScale = {
  density: BoardDensity
  /** Multi-column flow, not a grid — a ragged card next to a tall one would otherwise be
   *  inflated to match, which is dead space a wall board cannot afford. Same reasoning the first
   *  density rebuild measured; see that commit's note, preserved here. */
  columnsClass: string
  /** The table number — the one fact a cook resolves before walking over. */
  tableClass: string
  /** Item name + quantity — the second-biggest thing on a round. Floor: 24px at 3m. */
  itemClass: string
  /** The modifier / note. Smaller on purpose: it matters once you are already at the right round. */
  noteClass: string
  /** Per-line bump button. */
  buttonClass: string
  /** Round border width. Colour is the age signal, so the border never gets thin enough to lose
   *  it — but it no longer needs to be thick to be seen, because the body tint carries it too. */
  borderClass: string
  cardPadClass: string
  rowPadClass: string
}

const ROOMY: DensityScale = {
  density: 'roomy',
  columnsClass: 'columns-2 xl:columns-3',
  tableClass: 'text-4xl',
  itemClass: 'text-2xl',
  noteClass: 'text-base',
  buttonClass: 'px-3 py-1.5 text-lg',
  borderClass: 'border-2',
  cardPadClass: 'px-3 py-1.5',
  rowPadClass: 'py-1',
}

const STANDARD: DensityScale = {
  density: 'standard',
  columnsClass: 'columns-3 xl:columns-4',
  tableClass: 'text-3xl',
  itemClass: 'text-2xl',
  noteClass: 'text-sm',
  buttonClass: 'px-2.5 py-1 text-base',
  borderClass: 'border-2',
  cardPadClass: 'px-2.5 py-1',
  rowPadClass: 'py-0.5',
}

const COMPACT: DensityScale = {
  density: 'compact',
  columnsClass: 'columns-4 xl:columns-6',
  // 30px. The floor for a number read across a kitchen.
  tableClass: 'text-3xl',
  // 24px. The floor for an item name at 3m — below this the board is decorative. UNCHANGED from
  // the first density rebuild: this tier buys columns with chrome, not with this.
  itemClass: 'text-2xl',
  noteClass: 'text-sm',
  buttonClass: 'px-2 py-0.5 text-sm',
  borderClass: 'border-2',
  cardPadClass: 'px-2 py-1',
  rowPadClass: 'py-0.5',
}

/**
 * The thresholds. Lower than the first density rebuild's (which were tuned for a card taking up
 * to 500px of a FULL-height board) because a zone now gets a FRACTION of the wall — the active
 * zone roughly 65-70%, the pinned Ready zone the rest — not all of it. Derived from round heights
 * with the new chrome, then measured in a real browser by the e2e spec rather than left as
 * arithmetic, same discipline the first cut used.
 */
export const ROOMY_MAX_ROUNDS = 5
export const STANDARD_MAX_ROUNDS = 10

export function densityFor(roundCount: number): DensityScale {
  if (roundCount <= ROOMY_MAX_ROUNDS) return ROOMY
  if (roundCount <= STANDARD_MAX_ROUNDS) return STANDARD
  return COMPACT
}
