/**
 * Scoped to the kitchen board only — the parallel bar-screen rebuild is not this agent's file to
 * touch or to depend on being runtime-clean while this proof is captured. Same fixture/viewport
 * contract as scripts/shoot-board-proof.mjs (STATION_PREVIEW_BASE_URL, 1920x1080).
 *
 * Usage: node scripts/shoot-kitchen-proof.mjs docs/proof/kitchen-board-40-rounds.png
 */
import { chromium } from 'playwright'

const BASE = process.env.STATION_PREVIEW_BASE_URL || 'http://localhost:3211'
const OUT_PATH = process.argv[2]

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
await page.goto(`${BASE}/dev-kitchen-preview`, { waitUntil: 'load' })
await page.waitForSelector('[data-testid="station-board-body"]', { timeout: 30000 })
await page.waitForTimeout(500)
await page.screenshot({ path: OUT_PATH })
await ctx.close()
await browser.close()
console.log(`wrote ${OUT_PATH}`)
