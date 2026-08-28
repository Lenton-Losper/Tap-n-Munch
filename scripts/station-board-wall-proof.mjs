/**
 * Renders both station boards at 1920x1080 with the twenty-table fixture and writes the PNGs the
 * report references, plus the measurements that decide whether the layout actually works.
 *
 * A DESCRIPTION OF A LAYOUT IS NOT A PROOF OF ONE. The defect this rebuild answers ("two cards fill
 * the width and a busy board scrolls") is invisible in a DOM dump and invisible at four tables. So
 * this takes a real screenshot from a real browser at the real wall size, and prints the two numbers
 * that matter — the board's scrollHeight against its clientHeight — next to it.
 *
 * Usage (the dev server is NOT started for you, on purpose: a script that boots a server hides the
 * failure where the server is the thing that is broken):
 *
 *     npx next dev -p 3210
 *     node scripts/station-board-wall-proof.mjs http://localhost:3210
 *
 * Writes docs/proof/station-board-kitchen-1920x1080.png and
 * docs/proof/station-board-bar-1920x1080.png. Exits non-zero if either board scrolls.
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? 'http://localhost:3210'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'proof')

const BOARDS = [
  { name: 'kitchen', path: '/dev-kitchen-preview', screen: 'kitchen-screen', file: 'station-board-kitchen-1920x1080.png' },
  { name: 'bar', path: '/dev-bar-preview', screen: 'bar-screen', file: 'station-board-bar-1920x1080.png' },
]

mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })

let failed = false

for (const board of BOARDS) {
  const page = await context.newPage()
  await page.goto(`${BASE}${board.path}`, { waitUntil: 'networkidle' })
  await page.waitForSelector(`[data-testid="${board.screen}"]`)

  const measured = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="station-board-body"]')
    const cards = Array.from(
      document.querySelectorAll(
        '[data-testid="pass-table-card"], [data-testid="outstanding-table-card"], [data-testid="bar-round-card"]',
      ),
    )
    const rowText = Array.from(document.querySelectorAll('[data-testid="station-line-row"] p'))
    return {
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      scrollWidth: body.scrollWidth,
      clientWidth: body.clientWidth,
      cards: cards.length,
      columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
      density: document.querySelector('[data-density]')?.getAttribute('data-density') ?? null,
      borderColours: [...new Set(cards.map((c) => getComputedStyle(c).borderTopColor))],
      escalations: [...new Set(cards.map((c) => c.dataset.escalation ?? 'none'))],
      smallestRowFontPx: rowText.length
        ? Math.min(...rowText.map((p) => parseFloat(getComputedStyle(p).fontSize)))
        : null,
      largestTableFontPx: Math.max(
        ...cards.map((c) => parseFloat(getComputedStyle(c.querySelector('p')).fontSize)),
      ),
    }
  })

  const out = join(OUT_DIR, board.file)
  await page.screenshot({ path: out })

  // BOTH AXES. A multi-column flow that runs out of vertical room does not grow downwards — it
  // adds columns to the RIGHT, so a height-only check would report a fitting board while half the
  // service sat off the side of the wall.
  const fits =
    measured.scrollHeight <= measured.clientHeight && measured.scrollWidth <= measured.clientWidth
  if (!fits) failed = true

  console.log(`\n=== ${board.name.toUpperCase()} — ${BASE}${board.path} @1920x1080 ===`)
  console.log(`  saved:              docs/proof/${board.file}`)
  console.log(`  cards:              ${measured.cards}`)
  console.log(`  columns:            ${measured.columns}`)
  console.log(`  density tier:       ${measured.density}`)
  console.log(`  board height:       ${measured.scrollHeight}px content in ${measured.clientHeight}px`)
  console.log(`  board width:        ${measured.scrollWidth}px content in ${measured.clientWidth}px`)
  console.log(`  fits the wall:      ${fits ? 'YES' : 'NO - IT SCROLLS'}`)
  console.log(`  border colours:     ${measured.borderColours.length}  ${JSON.stringify(measured.borderColours)}`)
  console.log(`  escalation tiers:   ${JSON.stringify(measured.escalations)}`)
  console.log(`  smallest row text:  ${measured.smallestRowFontPx}px`)
  console.log(`  table number text:  ${measured.largestTableFontPx}px`)

  await page.close()
}

await context.close()
await browser.close()

if (failed) {
  console.error('\nAT LEAST ONE BOARD SCROLLS AT 1920x1080. That is the defect, not a warning.')
  process.exit(1)
}
console.log('\nBoth boards fit the wall without scrolling.')
