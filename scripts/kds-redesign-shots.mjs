/**
 * Screenshots of the redesigned Kitchen and Bar boards at a real 1920x1080 KDS viewport.
 *
 * Local visual QA only: renders the /dev-*-preview routes (no auth, no network, frozen clock)
 * against the redesign's quiet and busy scenarios. Touches no database and no production data.
 *
 * Usage: node scripts/kds-redesign-shots.mjs [baseUrl]
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? 'http://localhost:3210'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'proof')

const SHOTS = [
  { file: 'kds-kitchen-quiet-1920x1080.png', path: '/dev-kitchen-preview?scenario=quiet', screen: 'kitchen-screen' },
  { file: 'kds-kitchen-12-1920x1080.png', path: '/dev-kitchen-preview?scenario=busy', screen: 'kitchen-screen' },
  { file: 'kds-kitchen-20-1920x1080.png', path: '/dev-kitchen-preview?scenario=v20', screen: 'kitchen-screen' },
  { file: 'kds-kitchen-40-1920x1080.png', path: '/dev-kitchen-preview?scenario=v40', screen: 'kitchen-screen' },
  { file: 'kds-bar-quiet-1920x1080.png', path: '/dev-bar-preview?scenario=quiet', screen: 'bar-screen' },
  { file: 'kds-bar-12-1920x1080.png', path: '/dev-bar-preview?scenario=busy', screen: 'bar-screen' },
  { file: 'kds-bar-20-1920x1080.png', path: '/dev-bar-preview?scenario=v20', screen: 'bar-screen' },
  { file: 'kds-bar-40-1920x1080.png', path: '/dev-bar-preview?scenario=v40', screen: 'bar-screen' },
]

mkdirSync(OUT_DIR, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })

for (const shot of SHOTS) {
  await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' })
  await page.waitForSelector(`[data-testid="${shot.screen}"]`, { timeout: 20000 })
  // The Next dev-mode indicator is a dev-server artifact, not part of the board. It renders as a
  // floating badge over the bottom-left corner — exactly where OLDER UNRESOLVED sits — so it is
  // hidden for the capture. Nothing else is altered.
  await page.addStyleTag({ content: 'nextjs-portal, #__next-build-watcher { display: none !important; }' })
  await page.waitForTimeout(400)

  const body = await page.$(`[data-testid="station-board-body"]`)
  const metrics = await page.evaluate(() => {
    const pick = (sel) => document.querySelector(sel)
    const screen = pick('[data-testid="kitchen-screen"]') ?? pick('[data-testid="bar-screen"]')
    const grid = pick('[data-testid="active-grid"]') ?? pick('[data-testid="bar-active-grid"]')
    const ready = pick('[data-testid="ready-section"]') ?? pick('[data-testid="bar-ready-section"]')
    const older = pick('[data-testid="older-unresolved-section"]')
    const doc = document.documentElement
    return {
      density: screen?.getAttribute('data-density') ?? null,
      activeCards: document.querySelectorAll('[data-testid="active-table-card"],[data-testid="bar-round-card"]').length,
      readyRows: document.querySelectorAll('[data-testid="dispatch-row"]').length,
      readyCollapsed: ready?.getAttribute('data-ready-collapsed') ?? null,
      readyHeightPx: ready ? Math.round(ready.getBoundingClientRect().height) : null,
      olderCount: older?.getAttribute('data-older-count') ?? null,
      olderOpen: older?.getAttribute('data-older-open') ?? null,
      // THE regression this redesign exists to prevent.
      pageScrollsHorizontally: doc.scrollWidth > doc.clientWidth,
      gridScrollsHorizontally: grid ? grid.scrollWidth > grid.clientWidth : false,
      pageScrollsVertically: doc.scrollHeight > doc.clientHeight,
      // THE DEAD BAND: vertical gap between the last Active card and the READY divider.
      deadBandPx: (() => {
        const cards = Array.from(
          document.querySelectorAll('[data-testid="active-table-card"],[data-testid="bar-round-card"]'),
        )
        if (!cards.length || !ready) return null
        const lowest = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom))
        return Math.round(ready.getBoundingClientRect().top - lowest)
      })(),
      // PACKING WASTE: grid area minus the area the cards actually occupy.
      packingWastePct: (() => {
        if (!grid) return null
        const cards = Array.from(
          document.querySelectorAll('[data-testid="active-table-card"],[data-testid="bar-round-card"]'),
        )
        if (!cards.length) return null
        const rects = cards.map((c) => c.getBoundingClientRect())
        const top = Math.min(...rects.map((r) => r.top))
        const bottom = Math.max(...rects.map((r) => r.bottom))
        const gridW = grid.getBoundingClientRect().width
        const occupied = rects.reduce((sum, r) => sum + r.width * r.height, 0)
        const envelope = gridW * (bottom - top)
        return envelope > 0 ? Math.round(100 - (occupied / envelope) * 100) : null
      })(),
    }
  })

  await page.screenshot({ path: join(OUT_DIR, shot.file) })
  console.log(
    `${shot.file.padEnd(38)} density=${String(metrics.density).padEnd(9)} active=${String(metrics.activeCards).padEnd(3)} ` +
      `ready=${String(metrics.readyRows).padEnd(2)}(${metrics.readyCollapsed === 'true' ? 'collapsed' : 'expanded'}, ${metrics.readyHeightPx}px) ` +
      `older=${metrics.olderCount} h-scroll=${metrics.pageScrollsHorizontally || metrics.gridScrollsHorizontally ? '*** YES ***' : 'no'} ` +
      `deadBand=${String(metrics.deadBandPx).padStart(4)}px packingWaste=${String(metrics.packingWastePct).padStart(3)}%`,
  )
  void body
}

await browser.close()
console.log(`\nwritten to ${OUT_DIR}`)
