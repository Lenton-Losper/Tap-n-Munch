/**
 * DOES A FULL BOARD ACTUALLY FIT ON THE WALL?
 *
 * ============================================================================================
 * WHY THIS EXISTS SEPARATELY FROM THE JEST SUITE
 * ============================================================================================
 *
 * The layout question only exists at volume. Four table cards fit any layout, so the render suite
 * — jsdom, no layout engine, scrollHeight and clientHeight both zero — cannot answer the only
 * question that matters here: at 1920x1080, with twenty tables on it, does the board run off the
 * bottom of a screen nobody can reach up and scroll?
 *
 * That needs a real browser doing real layout. This is that.
 *
 * ============================================================================================
 * WHAT IT ASSERTS, AND WHY NOT "THE 88-MINUTE CARD IS RED"
 * ============================================================================================
 *
 * 1. THE BOARD DOES NOT SCROLL. scrollHeight <= clientHeight on the one scrollable element. This is
 *    the whole defect, measured: "currently two cards fill the width and a busy board scrolls,
 *    which is useless on a wall nobody touches."
 *
 * 2. THE CARDS TILE ACROSS, not down. At least four distinct column positions, so a regression to a
 *    one- or two-column stack fails here even if it happened to fit.
 *
 * 3. THE COLOURS DISCRIMINATE. More than one border colour across the board, read from the rendered
 *    pixels rather than from a class name — a card whose border colour a stylesheet change stopped
 *    applying would still carry the right data attribute.
 *
 * Asserting a specific card is a specific colour would pass identically before and after the fix
 * and would prove nothing; asserting the SET has more than one member is what separates a board a
 * cook can triage from a wall of identical cards.
 *
 * ============================================================================================
 * HOW TO RUN IT — IT DOES NOT POINT AT STAGING
 * ============================================================================================
 *
 * playwright.config.ts's baseURL is the staging worker, and the dev preview routes are local-only
 * (no auth, frozen clock, fixture data). So this reads STATION_PREVIEW_BASE_URL and SKIPS when it
 * is not set, rather than silently measuring the wrong thing:
 *
 *     npx next dev -p 3210
 *     STATION_PREVIEW_BASE_URL=http://localhost:3210 npx playwright test station-board-wall-fit
 */
import { test, expect } from '@playwright/test'

const PREVIEW_BASE = process.env.STATION_PREVIEW_BASE_URL
const WALL = { width: 1920, height: 1080 }

const BOARDS = [
  { name: 'kitchen', path: '/dev-kitchen-preview', screen: 'kitchen-screen' },
  { name: 'bar', path: '/dev-bar-preview', screen: 'bar-screen' },
] as const

test.describe('the station boards at 1920x1080 with twenty tables', () => {
  test.skip(!PREVIEW_BASE, 'set STATION_PREVIEW_BASE_URL to a local `next dev` to measure the wall')

  for (const board of BOARDS) {
    test(`${board.name}: twenty cards fit without the board scrolling`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
      const page = await ctx.newPage()
      await page.goto(`${PREVIEW_BASE}${board.path}`, { waitUntil: 'networkidle' })
      await page.waitForSelector(`[data-testid="${board.screen}"]`)

      const measured = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="station-board-body"]') as HTMLElement
        const cards = Array.from(
          document.querySelectorAll(
            '[data-testid="pass-table-card"], [data-testid="outstanding-table-card"], [data-testid="bar-round-card"]',
          ),
        ) as HTMLElement[]
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
      })

      console.log(`${board.name.toUpperCase()} @1920x1080`, JSON.stringify(measured, null, 2))

      expect(measured.cardCount, 'the fixture must put twenty cards on the board').toBe(20)
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

  test('kitchen: age is carried by more than one border colour', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(`${PREVIEW_BASE}/dev-kitchen-preview`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="kitchen-screen"]')

    const colours = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll('[data-testid="pass-table-card"], [data-testid="outstanding-table-card"]'),
      ) as HTMLElement[]
      return [...new Set(cards.map((c) => getComputedStyle(c).borderTopColor))]
    })

    console.log('KITCHEN BORDER COLOURS', colours)
    expect(colours.length, 'every card the same colour means the colour carries nothing').toBeGreaterThanOrEqual(3)
    await ctx.close()
  })

  /**
   * THE STANDING BAR RULING, MEASURED RATHER THAN ASSUMED. "A warm beer is a smaller problem than a
   * cold steak" — bar age is display-only. The bar fixture spans one minute to 12877, so a board
   * that had quietly started escalating would show more than one border colour here.
   */
  test('bar: still exactly ONE border colour at every age', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: WALL, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.goto(`${PREVIEW_BASE}/dev-bar-preview`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="bar-screen"]')

    const colours = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="bar-round-card"]')) as HTMLElement[]
      return [...new Set(cards.map((c) => getComputedStyle(c).borderTopColor))]
    })

    console.log('BAR BORDER COLOURS', colours)
    expect(colours).toHaveLength(1)
    await ctx.close()
  })
})
