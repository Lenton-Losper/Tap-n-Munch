/**
 * DOES A FULL BOARD ACTUALLY FIT ON THE WALL?
 *
 * ============================================================================================
 * WHY THIS EXISTS SEPARATELY FROM THE JEST SUITE
 * ============================================================================================
 *
 * The layout question only exists at volume. A handful of rounds fit any layout, so the render
 * suite — jsdom, no layout engine, scrollHeight and clientHeight both zero — cannot answer the
 * only question that matters here: at 1920x1080, with real volume on it, does the board run off
 * the bottom of a screen nobody can reach up and scroll?
 *
 * That needs a real browser doing real layout. This is that.
 *
 * ============================================================================================
 * REBUILT AGAIN, SECOND PASS (20260829) — 68/32 FIXED SURFACES, READY IS ROWS NOT CARDS, 40 ROUNDS
 * ============================================================================================
 *
 * Three things changed from the first pass's version of this spec:
 *
 *   1. FORTY rounds, not twenty — "screenshot at 1920x1080 with 40 rounds" is the redesign's own
 *      proof requirement, and it is the size that found the real overflow this spec now guards:
 *      COMPACT's 4-column cap fit an 11-20-round Active zone but ran taller than its 68% share at
 *      real stress (see lib/stations/board-density.ts's DENSE tier).
 *   2. READY IS NO LONGER CARDS. `ready-table-card` / round-shaped Ready cards are gone on both
 *      boards — a Ready line is now a `dispatch-row`, tested separately below rather than folded
 *      into the same card-shaped assertions as Active.
 *   3. THE ACTIVE/READY SPLIT IS A REAL, MEASURED FRACTION now (68%/32%), not just "pinned
 *      somewhere below active" — checked directly against `active-section` / `ready-section`
 *      (kitchen) and `bar-active-section` / `bar-ready-section` (bar) client heights.
 *
 * ============================================================================================
 * WHAT IT ASSERTS, AND WHY NOT "THE 88-MINUTE CARD IS RED"
 * ============================================================================================
 *
 * 1. THE BOARD DOES NOT SCROLL. scrollHeight <= clientHeight on the one scrollable element.
 * 2. ACTIVE'S CARDS TILE ACROSS, not down. At least four distinct column positions.
 * 3. THE COLOURS DISCRIMINATE, read from the rendered pixels rather than from a class name.
 * 4. THE 68/32 SPLIT IS REAL, within a few percentage points either way.
 *
 * ============================================================================================
 * HOW TO RUN IT — IT DOES NOT POINT AT STAGING
 * ============================================================================================
 *
 *     npx next dev -p 3210
 *     STATION_PREVIEW_BASE_URL=http://localhost:3210 npx playwright test station-board-wall-fit
 */
import { test, expect } from '@playwright/test'

const PREVIEW_BASE = process.env.STATION_PREVIEW_BASE_URL
const WALL = { width: 1920, height: 1080 }

const BOARDS = [
  {
    name: 'kitchen',
    path: '/dev-kitchen-preview',
    screen: 'kitchen-screen',
    activeSection: 'active-section',
    readySection: 'ready-section',
    activeCard: 'active-table-card',
  },
  {
    name: 'bar',
    path: '/dev-bar-preview',
    screen: 'bar-screen',
    activeSection: 'bar-active-section',
    readySection: 'bar-ready-section',
    activeCard: 'bar-round-card',
  },
] as const

test.describe('the station boards at 1920x1080 with forty rounds', () => {
  test.skip(!PREVIEW_BASE, 'set STATION_PREVIEW_BASE_URL to a local `next dev` to measure the wall')

  for (const board of BOARDS) {
    test(`${board.name}: the board does not scroll, Active tiles across, and the 68/32 split holds`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
      const page = await ctx.newPage()
      await page.goto(`${PREVIEW_BASE}${board.path}`, { waitUntil: 'networkidle' })
      await page.waitForSelector(`[data-testid="${board.screen}"]`)

      const measured = await page.evaluate(
        ({ activeSection, readySection, activeCard }) => {
          const body = document.querySelector('[data-testid="station-board-body"]') as HTMLElement
          const active = document.querySelector(`[data-testid="${activeSection}"]`) as HTMLElement
          const ready = document.querySelector(`[data-testid="${readySection}"]`) as HTMLElement
          const cards = Array.from(document.querySelectorAll(`[data-testid="${activeCard}"]`)) as HTMLElement[]
          const rows = Array.from(document.querySelectorAll('[data-testid="dispatch-row"]'))

          return {
            scrollHeight: body.scrollHeight,
            clientHeight: body.clientHeight,
            scrollWidth: body.scrollWidth,
            clientWidth: body.clientWidth,
            activeHeight: active.clientHeight,
            readyHeight: ready.clientHeight,
            activeCardCount: cards.length,
            readyRowCount: rows.length,
            // Distinct left edges = distinct columns. Rounded, because sub-pixel grid maths is not
            // the thing under test.
            columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
            escalations: [...new Set(cards.map((c) => c.dataset.escalation ?? 'none'))],
            // The SMALLEST text in a row, which is the modifier line, not the item name. Reported so
            // a density change that quietly drops below legibility shows up in the log.
            smallestRowTextPx: Math.min(
              ...(Array.from(document.querySelectorAll('[data-testid="station-line-row"] p')) as HTMLElement[]).map(
                (p) => parseFloat(getComputedStyle(p).fontSize),
              ),
            ),
          }
        },
        { activeSection: board.activeSection, readySection: board.readySection, activeCard: board.activeCard },
      )

      console.log(`${board.name.toUpperCase()} @1920x1080`, JSON.stringify(measured, null, 2))

      expect(
        measured.scrollHeight,
        `the board is ${measured.scrollHeight}px tall in a ${measured.clientHeight}px window — a wall screen cannot be scrolled`,
      ).toBeLessThanOrEqual(measured.clientHeight)
      // BOTH AXES. A multi-column flow out of vertical room adds columns to the RIGHT rather than
      // growing downwards, so a height-only check would pass a board with half the service off the
      // side of the wall.
      expect(
        measured.scrollWidth,
        `the board is ${measured.scrollWidth}px wide in a ${measured.clientWidth}px window`,
      ).toBeLessThanOrEqual(measured.clientWidth)
      expect(measured.columns, 'Active must tile across the wall, not stack down it').toBeGreaterThanOrEqual(4)
      expect(measured.readyRowCount, 'the fixture must put ready rows on the board').toBeGreaterThan(0)

      // "68% active, 32% ready" — real height, not a suggestion. A few points of slack for chrome
      // (dividers, section headings) either side of the exact ratio.
      const activeShare = measured.activeHeight / (measured.activeHeight + measured.readyHeight)
      expect(activeShare, `Active is ${(activeShare * 100).toFixed(1)}% of the two-surface height, want ~68%`).toBeGreaterThan(0.55)
      expect(activeShare, `Active is ${(activeShare * 100).toFixed(1)}% of the two-surface height, want ~68%`).toBeLessThan(0.8)

      await ctx.close()
    })
  }

  test('kitchen: age is carried by more than one border colour in Active, and in Ready', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(`${PREVIEW_BASE}/dev-kitchen-preview`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="kitchen-screen"]')

    const colours = await page.evaluate(() => {
      const colourSet = (selector: string, prop: 'borderTopColor' | 'backgroundColor' = 'borderTopColor') =>
        [...new Set((Array.from(document.querySelectorAll(selector)) as HTMLElement[]).map((c) => getComputedStyle(c)[prop]))]
      return {
        active: colourSet('[data-testid="active-table-card"]'),
        ready: colourSet('[data-testid="dispatch-row"]', 'borderTopColor'),
      }
    })

    console.log('KITCHEN COLOURS', colours)
    expect(colours.active.length, 'every active round the same colour means the colour carries nothing').toBeGreaterThanOrEqual(3)
    expect(colours.ready.length, 'every ready row the same colour means the colour carries nothing').toBeGreaterThanOrEqual(3)
    await ctx.close()
  })

  /**
   * THE STANDING BAR RULING, MEASURED RATHER THAN ASSUMED — REVERSED FROM THE FIRST PASS. TO MAKE
   * used to be neutral by ruling ("a warm beer is a smaller problem than a cold steak"); the
   * second pass reversed that once the board held real volume ("at twelve it costs more than it
   * saves"), so this now asserts the OPPOSITE of what the first pass's spec asserted: TO MAKE
   * must discriminate too, just on later bands than the kitchen, and Waiting for collection must
   * discriminate on its own SOFTER-than-kitchen bands.
   */
  test('bar: TO MAKE discriminates by colour (reversed from the first pass); Waiting for collection does too', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(`${PREVIEW_BASE}/dev-bar-preview`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="bar-screen"]')

    const colours = await page.evaluate(() => {
      const colourSet = (selector: string) =>
        [...new Set((Array.from(document.querySelectorAll(selector)) as HTMLElement[]).map((c) => getComputedStyle(c).borderTopColor))]
      return {
        active: colourSet('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]'),
        ready: colourSet('[data-testid="bar-ready-list"] [data-testid="dispatch-row"]'),
      }
    })

    console.log('BAR COLOURS', colours)
    expect(colours.active.length, 'TO MAKE must now discriminate by age — the "always neutral" ruling was reversed').toBeGreaterThanOrEqual(3)
    expect(colours.ready.length, 'Waiting for collection must discriminate by age, on its own softer bands').toBeGreaterThanOrEqual(3)
    await ctx.close()
  })
})
