/**
 * B5 — the browse header holds three labelled controls without truncating the restaurant name.
 *
 * A comment in the header records that a third labelled control pushed the name to "S…". `navTab`
 * is that third control, so its wording is a LAYOUT decision as much as a copy one.
 *
 * WHAT THIS CAN AND CANNOT DO: it measures the rendered widths in a headless Chromium at a
 * phone viewport. A real device — different font metrics, different pixel ratio, a longer
 * restaurant name than the fixture's — is not this. The numbers below are evidence, not a
 * guarantee, and the human is clicking it on a phone regardless.
 */
import { test, expect } from '@playwright/test'
import { assertStagingDb, assertServedAppUsesStaging, seedTableWithOrder, adoptSession, teardown, FIXTURE_RESTAURANT, type Fixture } from './lib/fixture'
import type { SupabaseClient } from '@supabase/supabase-js'

let db: SupabaseClient
let fixture: Partial<Fixture> = {}

test.beforeAll(async ({ baseURL }) => {
  db = assertStagingDb()
  await assertServedAppUsesStaging(baseURL!)
})
test.afterEach(async () => { await teardown(db, fixture); fixture = {} })

test.describe('B5 — the browse header at a phone width', () => {
  test('reports the header widths and whether any label is clipped', async ({ browser, baseURL }) => {
    const f = await seedTableWithOrder(db)
    fixture = f
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }) // iPhone 14
    await adoptSession(ctx, baseURL!, f)
    const page = await ctx.newPage()
    await page.goto(`${baseURL}/menu/${FIXTURE_RESTAURANT}/browse?table=${f.tableNumber}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)

    const report = await page.evaluate(() => {
      const clipped = (el: Element) => {
        const e = el as HTMLElement
        return e.scrollWidth > e.clientWidth + 1
      }
      const out: Array<Record<string, unknown>> = []
      for (const el of Array.from(document.querySelectorAll('header *, [class*="header"] *'))) {
        const e = el as HTMLElement
        const t = (e.innerText || '').trim()
        if (!t || t.length > 40 || e.children.length > 0) continue
        const r = e.getBoundingClientRect()
        if (r.width === 0) continue
        out.push({ text: t, w: Math.round(r.width), scrollW: e.scrollWidth, clientW: e.clientWidth, clipped: clipped(e), ellipsis: getComputedStyle(e).textOverflow })
      }
      return { viewport: window.innerWidth, items: out.slice(0, 14) }
    })

    console.log('B5 HEADER MEASUREMENT viewport=' + report.viewport)
    for (const i of report.items) {
      console.log(`  "${i.text}"  width=${i.w}px  scroll=${i.scrollW}/${i.clientW}  clipped=${i.clipped}  textOverflow=${i.ellipsis}`)
    }
    const clippedItems = report.items.filter((i) => i.clipped)
    console.log(`  CLIPPED: ${clippedItems.length ? clippedItems.map((i) => i.text).join(', ') : 'none'}`)

    // Reported, not gated: the human clicks a real phone. Assert only that the header rendered.
    expect(report.items.length, 'the header rendered no measurable labels — the selector missed').toBeGreaterThan(0)
    await ctx.close()
  })
})
