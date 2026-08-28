/**
 * lib/stations/board-density.ts — how many rounds go across the wall, and how big the type is.
 *
 * ============================================================================================
 * REBUILT 20260829160000, RETUNED 20260829 (second pass) — "roughly 4 columns, 8-10 rounds per
 * column" AND A READY ZONE THAT IS NO LONGER CARDS AT ALL
 * ============================================================================================
 *
 * The first density rebuild (2026-08-28) fixed "two cards across a 1920x1080 wall" by scaling
 * type size and column count together, then scaled COLUMN COUNT UP as high as xl:6 to fit more
 * rounds — which is exactly what made "Iced Coffee" wrap mid-phrase on real staging data: at
 * xl:6 a column is ~320px and a per-line row has to fit a name AND a button in it. The second
 * pass fixes the wrong lever: density buys ROOM by capping columns at roughly four (wider
 * columns) and by moving Ready off this scale entirely (dispatchDensityFor, below) rather than by
 * squeezing more columns out of the wall.
 *
 * TEXT FLOORS ARE UNCHANGED: 24px is still where an item name at 3m stops being legible. "No
 * oversized table numbers, no repeated giant buttons" (the second pass's own words) is about
 * CHROME at the loudest tier, not about pushing the text floor down — the win is still thinner
 * borders, tighter padding, fewer big per-round shortcuts, same as the first pass's own lesson.
 *
 * WHAT IS STILL NEVER TRADED AWAY: a line of food. No tier caps, truncates or hides a line, and
 * no tier collapses a table into a count.
 *
 * Measured, not asserted: tests/e2e/station-board-wall-fit.spec.ts renders a real-volume fixture
 * at 1920x1080 in a real browser and fails if either surface's content exceeds its own bounds.
 */

export type BoardDensity = 'roomy' | 'standard' | 'compact' | 'dense'

export type DensityScale = {
  density: BoardDensity
  /** Multi-column flow, not a grid — a ragged card next to a tall one would otherwise be
   *  inflated to match, which is dead space a wall board cannot afford. Capped at 4 columns even
   *  at the densest tier — the second pass's own "roughly 4 columns" target — so a column stays
   *  wide enough for a name and its button to share one line. */
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
  // Capped at 4, not scaled up to 5/6 — see the file docblock. ~480px per column at 1920px,
  // comfortable room for a name and its button on one line.
  columnsClass: 'columns-3 xl:columns-4',
  // 30px. The floor for a number read across a kitchen. Not "oversized" — this already IS the
  // smallest tier's number; "no oversized table numbers" is chrome guidance, not a floor change.
  tableClass: 'text-3xl',
  // 24px. The floor for an item name at 3m — below this the board is decorative. UNCHANGED.
  itemClass: 'text-2xl',
  noteClass: 'text-sm',
  buttonClass: 'px-2 py-0.5 text-sm',
  borderClass: 'border',
  cardPadClass: 'px-2 py-1',
  rowPadClass: 'py-0.5',
}

/**
 * A FOURTH TIER, FOUND BY ACTUALLY SCREENSHOTTING THE 40-ROUND FIXTURE. COMPACT's 4-column cap
 * fixed the wrapping defect, but at real stress (both board-owning agents independently hit this:
 * ~29-30 multi-item Active rounds in a 68%-height surface) four wide columns run TALLER than the
 * surface — bar's own screenshot showed the last TO MAKE row clipped behind the Ready divider,
 * which is exactly "a tier hides a line", the one thing this file has never allowed.
 *
 * DENSE trades a little of COMPACT's width back for height: 5 columns instead of 4. It only
 * engages well past the round count that motivated capping at 4 in the first place (that fix was
 * measured against an 11-20-round case, not a 29-round one), so the common "busy but not a stress
 * test" range still gets COMPACT's wider, wrap-proof columns.
 */
const DENSE: DensityScale = {
  density: 'dense',
  columnsClass: 'columns-4 xl:columns-5',
  tableClass: 'text-3xl',
  itemClass: 'text-2xl',
  noteClass: 'text-sm',
  buttonClass: 'px-1.5 py-0.5 text-sm',
  borderClass: 'border',
  cardPadClass: 'px-1.5 py-1',
  rowPadClass: 'py-0.5',
}

/**
 * The thresholds. A zone gets a FRACTION of the wall (Active ~68%, Ready ~32% — but Ready no
 * longer uses this scale at all, see dispatchDensityFor), derived from round heights with the
 * current chrome, then measured in a real browser by the e2e spec rather than left as arithmetic.
 */
export const ROOMY_MAX_ROUNDS = 5
export const STANDARD_MAX_ROUNDS = 10
export const COMPACT_MAX_ROUNDS = 20

export function densityFor(roundCount: number): DensityScale {
  if (roundCount <= ROOMY_MAX_ROUNDS) return ROOMY
  if (roundCount <= STANDARD_MAX_ROUNDS) return STANDARD
  if (roundCount <= COMPACT_MAX_ROUNDS) return COMPACT
  return DENSE
}

/**
 * ============================================================================================
 * THE READY ZONE'S OWN SCALE — ROWS, NOT CARDS
 * ============================================================================================
 *
 * Second pass: "no production cards. Dense rows... it is a dispatch queue, not a shrunken
 * production card." A DispatchRow has none of a StationCard's chrome (no border box, no card
 * padding, no per-round header) so it does not need DensityScale's card-shaped fields — just
 * enough to answer "how many columns of rows, how big is the text" at a given row count.
 *
 * Text floor is the SAME 24px item-name floor as the card scale, for the same reason: a dish name
 * on a dispatch row is exactly as real as one on a production card.
 */
export type DispatchDensity = {
  density: BoardDensity
  columnsClass: string
  rowTextClass: string
  clockClass: string
  buttonClass: string
  rowPadClass: string
}

const DISPATCH_ROOMY: DispatchDensity = {
  density: 'roomy',
  columnsClass: 'columns-1 xl:columns-2',
  rowTextClass: 'text-2xl',
  clockClass: 'text-xl',
  buttonClass: 'px-3 py-1 text-base',
  rowPadClass: 'py-1.5',
}

const DISPATCH_STANDARD: DispatchDensity = {
  density: 'standard',
  columnsClass: 'columns-2 xl:columns-3',
  rowTextClass: 'text-2xl',
  clockClass: 'text-lg',
  buttonClass: 'px-2.5 py-1 text-sm',
  rowPadClass: 'py-1',
}

const DISPATCH_COMPACT: DispatchDensity = {
  density: 'compact',
  columnsClass: 'columns-2 xl:columns-4',
  rowTextClass: 'text-2xl',
  clockClass: 'text-base',
  buttonClass: 'px-2 py-0.5 text-sm',
  rowPadClass: 'py-0.5',
}

export const DISPATCH_ROOMY_MAX_ROWS = 6
export const DISPATCH_STANDARD_MAX_ROWS = 16

export function dispatchDensityFor(rowCount: number): DispatchDensity {
  if (rowCount <= DISPATCH_ROOMY_MAX_ROWS) return DISPATCH_ROOMY
  if (rowCount <= DISPATCH_STANDARD_MAX_ROWS) return DISPATCH_STANDARD
  return DISPATCH_COMPACT
}
