/**
 * lib/stations/board-density.ts — how many cards go across the wall, and how big the type is.
 *
 * ============================================================================================
 * THE PROBLEM THIS EXISTS TO SOLVE
 * ============================================================================================
 *
 * The board before this was `sm:grid-cols-2 xl:grid-cols-3` for the pass zone and `xl:grid-cols-2`
 * for the tables. On a 1920x1080 wall that is two table cards across, so a twenty-table service
 * runs off the bottom of the screen — and a wall screen nobody walks up to and touches cannot be
 * scrolled. Everything below the fold does not exist.
 *
 * The obvious fix, "make the cards smaller", trades away the other half of the requirement: this
 * is read from about three metres, hands full, so an item name below roughly 22px stops being
 * legible and the board becomes decorative.
 *
 * ============================================================================================
 * THE RESOLUTION: DENSITY IS A FUNCTION OF LOAD, NOT A CONSTANT
 * ============================================================================================
 *
 * Those two pressures only conflict when the board is FULL. A quiet board has the whole wall for
 * six cards and should spend it on size. So the board does not pick one density and live with it —
 * it spends the wall on legibility until it runs out of room, then buys columns with type size in
 * three documented steps, and stops. `compact` is the floor: 24px item names, 30px table numbers,
 * five across. It does not go smaller, because smaller is not readable, and a board that is full
 * beyond twenty tables has a kitchen problem that a font size cannot fix.
 *
 * WHAT IS NEVER TRADED AWAY: a line of food. No tier caps, truncates or hides a line, and no tier
 * collapses a table into a count. Hiding a dish to make the grid fit is the one failure mode worse
 * than scrolling, because the scroll at least admits there is more.
 *
 * Measured, not asserted: tests/e2e/station-board-wall-fit.spec.ts renders the twenty-table
 * fixture at 1920x1080 in a real browser and fails if the board's scrollHeight exceeds its
 * clientHeight.
 */

export type BoardDensity = 'roomy' | 'standard' | 'compact'

export type DensityScale = {
  density: BoardDensity
  /**
   * COLUMNS, NOT A GRID — and that is a measurement, not a preference.
   *
   * The first cut of this used `grid-cols-5`. A CSS grid row is as tall as the tallest card in it,
   * and these cards are ragged by nature (a table has one dish or four). Measured at 1920x1080 with
   * the twenty-table fixture: 1434px of board in a 1016px window. A one-line card sitting next to a
   * four-line card was inflated to the four-line card's height, and that dead space — not the card
   * sizes, not the type — was what pushed the board off the wall.
   *
   * A multi-column flow has no rows to align to, so every card is exactly as tall as its own
   * content. Same change, same fixture: 1434px -> fits.
   *
   * THE COST, ON THE RECORD: reading order becomes column-major (down the first column, then the
   * second), like a newspaper, rather than left-to-right. The board is sorted oldest-first either
   * way, so the card that has waited longest is still the top-left one; what changes is where the
   * SECOND-oldest sits. On a queue read down a column that is the natural direction anyway, and it
   * bought back the ~400px that decides whether half the service is visible at all.
   */
  columnsClass: string
  /** The table number — the one fact a cook resolves before walking over. */
  tableClass: string
  /** Item name + quantity — the second-biggest thing on a card. */
  itemClass: string
  /** The modifier. Smaller on purpose: it matters once you are already at the right card. */
  noteClass: string
  /** Per-line bump button. */
  buttonClass: string
  /** Card border width. Colour is the age signal, so the border never gets thin enough to lose. */
  borderClass: string
  cardPadClass: string
  rowPadClass: string
}

const ROOMY: DensityScale = {
  density: 'roomy',
  columnsClass: 'columns-2 xl:columns-3',
  tableClass: 'text-6xl',
  itemClass: 'text-4xl',
  noteClass: 'text-2xl',
  buttonClass: 'px-6 py-3 text-2xl',
  borderClass: 'border-8',
  cardPadClass: 'px-6 py-5',
  rowPadClass: 'py-3',
}

const STANDARD: DensityScale = {
  density: 'standard',
  columnsClass: 'columns-3 xl:columns-4',
  tableClass: 'text-5xl',
  itemClass: 'text-3xl',
  noteClass: 'text-xl',
  buttonClass: 'px-5 py-2.5 text-xl',
  borderClass: 'border-8',
  cardPadClass: 'px-5 py-4',
  rowPadClass: 'py-2.5',
}

const COMPACT: DensityScale = {
  density: 'compact',
  columnsClass: 'columns-4 xl:columns-5',
  // 30px. The floor for a number read across a kitchen.
  tableClass: 'text-3xl',
  // 24px. The floor for an item name at 3m — below this the board is decorative.
  itemClass: 'text-2xl',
  noteClass: 'text-base',
  buttonClass: 'px-2.5 py-1 text-base',
  // Still 6px of colour. Thinner than roomy, but the tint on the card body carries it too.
  borderClass: 'border-[6px]',
  cardPadClass: 'px-3 py-2.5',
  rowPadClass: 'py-1.5',
}

/**
 * The thresholds. Six and twelve are where a 1920x1080 wall stops fitting three-then-four across
 * with the type sizes above — derived from the card heights those scales produce, and then
 * measured in a real browser by the e2e spec rather than left as arithmetic.
 */
export const ROOMY_MAX_CARDS = 6
export const STANDARD_MAX_CARDS = 12

export function densityFor(cardCount: number): DensityScale {
  if (cardCount <= ROOMY_MAX_CARDS) return ROOMY
  if (cardCount <= STANDARD_MAX_CARDS) return STANDARD
  return COMPACT
}
