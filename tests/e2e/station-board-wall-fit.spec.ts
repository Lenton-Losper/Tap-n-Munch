/**
 * DOES A FULL BOARD ACTUALLY FIT ON THE WALL?
 *
 * ============================================================================================
 * WHY THIS EXISTS SEPARATELY FROM THE JEST SUITE
 * ============================================================================================
 *
 * The layout question only exists at volume. A handful of rounds fit any layout, so the render
 * suite — jsdom, no layout engine, scrollHeight and clientHeight both zero — cannot answer the
 * only question that matters here: at 1920x1080, with twenty rounds on it, does the board run
 * off the bottom of a screen nobody can reach up and scroll?
 *
 * That needs a real browser doing real layout. This is that.
 *
 * ============================================================================================
 * REBUILT 20260829160000 FOR THE PINNED READY ZONE
 * ============================================================================================
 *
 * Two things changed from the first density rebuild's version of this spec:
 *
 *   1. Cards now carry the testids `active-table-card` / `ready-table-card` (kitchen) and
 *      `bar-round-card` (bar, either zone) — the old `pass-table-card` / `outstanding-table-card`
 *      split is gone; see components/stations/kitchen-screen.tsx.
 *   2. The bar is no longer ONE colour at every age. TO MAKE still is — that ruling is unchanged —
 *      but Waiting for collection now ages the same way the kitchen's Ready zone does, so this
 *      spec checks each bar zone SEPARATELY rather than asserting the whole board is one colour.
 *
 * ============================================================================================
 * WHAT IT ASSERTS, AND WHY NOT "THE 88-MINUTE CARD IS RED"
 * ============================================================================================
 *
 * 1. THE BOARD DOES NOT SCROLL. scrollHeight <= clientHeight on the one scrollable element.
 *
 * 2. THE CARDS TILE ACROSS, not down. At least four distinct column positions.
 *
 * 3. THE COLOURS DISCRIMINATE, read from the rendered pixels rather than from a class name.
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

const CARD_SELECTOR = '[data-testid="active-table-card"], [data-testid="ready-table-card"], [data-testid="bar-round-card"]'

const BOARDS = [
  { name: 'kitchen', path: '/dev-kitchen-preview', screen: 'kitchen-screen' },
  { name: 'bar', path: '/dev-bar-preview', screen: 'bar-screen' },
] as const

test.describe('the station boards at 1920x1080 with twenty rounds', () => {
  test.skip(!PREVIEW_BASE, 'set STATION_PREVIEW_BASE_URL to a local `next dev` to measure the wall')

  for (const board of BOARDS) {
    test(`${board.name}: twenty rounds fit without the board scrolling`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
      const page = await ctx.newPage()
      await page.goto(`${PREVIEW_BASE}${board.path}`, { waitUntil: 'networkidle' })
      await page.waitForSelector(`[data-testid="${board.screen}"]`)

      const measured = await page.evaluate((cardSelector) => {
        const body = document.querySelector('[data-testid="station-board-body"]') as HTMLElement
        const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[]
        return {
          scrollHeight: body.scrollHeight,
          clientHeight: body.clientHeight,
          scrollWidth: body.scrollWidth,
          clientWidth: body.clientWidth,
          cardCount: cards.length,
          // Distinct left edges = distinct columns. Rounded, because sub-pixel grid maths is not
          // the thing under test.
          columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
          borderColours: [...new Set(cards.map((c) => getComputedStyle(c).borderTopColor))],
          escalations: [...new Set(cards.map((c) => c.dataset.escalation ?? 'none'))],
          // The SMALLEST text in a row, which is the modifier line, not the item name. Reported so
          // a density change that quietly drops below legibility shows up in the log.
          smallestRowTextPx: Math.min(
            ...(Array.from(document.querySelectorAll('[data-testid="station-line-row"] p')) as HTMLElement[]).map((p) =>
              parseFloat(getComputedStyle(p).fontSize),
            ),
          ),
        }
      }, CARD_SELECTOR)

      console.log(`${board.name.toUpperCase()} @1920x1080`, JSON.stringify(measured, null, 2))

      expect(measured.cardCount, 'the fixture must put twenty rounds on the board').toBe(20)
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
      expect(measured.columns, 'the cards must tile across the wall, not stack down it').toBeGreaterThanOrEqual(4)

      await ctx.close()
    })
  }

  test('kitchen: age is carried by more than one border colour in each zone', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(`${PREVIEW_BASE}/dev-kitchen-preview`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="kitchen-screen"]')

    const colours = await page.evaluate(() => {
      const colourSet = (selector: string) =>
        [...new Set(
          (Array.from(document.querySelectorAll(selector)) as HTMLElement[]).map(
            (c) => getComputedStyle(c).borderTopColor,
          ),
        )]
      return {
        active: colourSet('[data-testid="active-table-card"]'),
        ready: colourSet('[data-testid="ready-table-card"]'),
      }
    })

    console.log('KITCHEN BORDER COLOURS', colours)
    expect(colours.active.length, 'every active round the same colour means the colour carries nothing').toBeGreaterThanOrEqual(3)
    expect(colours.ready.length, 'every ready round the same colour means the colour carries nothing').toBeGreaterThanOrEqual(3)
    await ctx.close()
  })

  /**
   * THE STANDING BAR RULING, MEASURED RATHER THAN ASSUMED, NOW SCOPED PER ZONE. "A warm beer is a
   * smaller problem than a cold steak" — bar age is display-only, but ONLY on TO MAKE. The board
   * rebuild's own new ruling is that Waiting for collection ages like every other Ready zone, so
   * this spec checks the two zones separately rather than asserting the whole bar board is one
   * colour, which the previous version of this spec did and which would now be the wrong claim.
   */
  test('bar: TO MAKE is one colour at every age; Waiting for collection is not', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(`${PREVIEW_BASE}/dev-bar-preview`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="bar-screen"]')

    const colours = await page.evaluate(() => {
      const colourSet = (selector: string) =>
        [...new Set(
          (Array.from(document.querySelectorAll(selector)) as HTMLElement[]).map(
            (c) => getComputedStyle(c).borderTopColor,
          ),
        )]
      return {
        active: colourSet('[data-testid="bar-active-grid"] [data-testid="bar-round-card"]'),
        ready: colourSet('[data-testid="bar-ready-grid"] [data-testid="bar-round-card"]'),
      }
    })

    console.log('BAR BORDER COLOURS', colours)
    expect(colours.active, 'TO MAKE must stay neutral — the standing ruling').toHaveLength(1)
    expect(colours.ready.length, 'Waiting for collection must discriminate by age, like every other Ready zone').toBeGreaterThanOrEqual(3)
    await ctx.close()
  })
})
