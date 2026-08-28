/**
 * Captures docs/proof/*.png at 1920x1080 from the dev preview pages — the same fixture and
 * viewport tests/e2e/station-board-wall-fit.spec.ts measures, so a screenshot here and a passing
 * spec run are the same claim. Requires a local `next dev` (STATION_PREVIEW_BASE_URL, default
 * http://localhost:3210).
 *
 * Usage: node scripts/shoot-board-proof.mjs docs/proof
 */
import { chromium } from 'playwright'

const BASE = process.env.STATION_PREVIEW_BASE_URL || 'http://localhost:3210'
const OUT_DIR = process.argv[2]

const browser = await chromium.launch()
for (const [name, path] of [
  ['kitchen-board-20-rounds', '/dev-kitchen-preview'],
  ['bar-board-20-rounds', '/dev-bar-preview'],
]) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="station-board-body"]')
  await page.screenshot({ path: `${OUT_DIR}/${name}.png` })
  await ctx.close()
  console.log(`wrote ${OUT_DIR}/${name}.png`)
}
await browser.close()
