import { readFileSync } from 'fs'
import { join } from 'path'

import {
  PRE_LAUNCH_RESTAURANTS,
  isPreLaunchRestaurant,
  preLaunchRestaurant,
} from '@/lib/reporting/pre-launch-restaurants'

/**
 * Riviera's figures are WITHHELD from reporting until it opens. Ruled 2026-08-21.
 *
 * The alternative was a script that cancels completed, paid orders. It was rejected on the grounds
 * that a capability to un-book real sales is worth more as a thing that does not exist — so the
 * load-bearing property of this whole change is that **it alters no financial record**. These tests
 * exist to keep it that way, and to stop the withheld state degrading into a rendered zero.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('pre-launch reporting', () => {
  const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'

  it('matches Riviera and nothing else', () => {
    expect(isPreLaunchRestaurant(RIVIERA)).toBe(true)
    // The three trading venues must never be suppressed.
    expect(isPreLaunchRestaurant('b161c758-582d-4dfa-839a-9fa35c492a49')).toBe(false) // FNB ChowNow
    expect(isPreLaunchRestaurant('131c39d1-b816-407d-8c5f-e628fc38967e')).toBe(false) // Mingle
    expect(isPreLaunchRestaurant('38c493cf-a665-42c5-9c3e-858fbdb52b40')).toBe(false) // Chownow Nedbank
  })

  it('is case- and whitespace-insensitive, and safe on null', () => {
    expect(isPreLaunchRestaurant(RIVIERA.toUpperCase())).toBe(true)
    expect(isPreLaunchRestaurant(`  ${RIVIERA}  `)).toBe(true)
    expect(isPreLaunchRestaurant(null)).toBe(false)
    expect(isPreLaunchRestaurant(undefined)).toBe(false)
    expect(isPreLaunchRestaurant('')).toBe(false)
  })

  it('every entry carries a reason naming what removes it', () => {
    // An exclusion list with no stated exit condition becomes permanent by accident, and this one
    // suppresses REVENUE. Each entry has to say when it goes.
    for (const entry of PRE_LAUNCH_RESTAURANTS) {
      expect(entry.reason.trim().length).toBeGreaterThan(30)
      expect(entry.reason.toLowerCase()).toMatch(/remove this entry/)
    }
    expect(preLaunchRestaurant(RIVIERA)?.name).toBe('Riviera')
  })

  it('the API WITHHOLDS the figures rather than sending zero', () => {
    // A rendered 0.00 is indistinguishable from a real week with no sales. null is not.
    const src = read('app/api/orders/history/route.ts')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).toMatch(/totalRevenue:\s*preLaunch\s*\?\s*null\s*:/)
    expect(code).toMatch(/totalOrders:\s*preLaunch\s*\?\s*null\s*:/)
    expect(code).toMatch(/avgOrderValue:\s*preLaunch\s*\?\s*null\s*:/)
    // The guard must never be written as a zero.
    expect(code).not.toMatch(/totalRevenue:\s*preLaunch\s*\?\s*0\s*:/)
  })

  it('the ORDERS array is never filtered — only the roll-up is suppressed', () => {
    // Hiding the rows would make the withheld state unauditable, and would be a step towards the
    // deletion this ruling explicitly refused. Every row stays inspectable.
    const src = read('app/api/orders/history/route.ts')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).toMatch(/orders:\s*enrichedOrders,/)
    expect(code).not.toMatch(/orders:\s*preLaunch\s*\?/)
  })

  it('changes no financial record — the module touches no table', () => {
    // The whole point of choosing this over the cancel script. If this module ever gains a write,
    // the ruling has been quietly reversed.
    //
    // COMMENTS STRIPPED FIRST, and the first version of this assertion did not -- it matched the
    // docblock's reference to `lib/supabase/analytics.ts` and failed against a module that touches
    // nothing. Assert against code, never commentary; it is the same trap the tab back-button test
    // and check-no-pending-copy.mjs both had to be built around.
    const src = read('lib/reporting/pre-launch-restaurants.ts')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ 	]*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\.from\(|\.update\(|\.insert\(|\.delete\(|supabase/i)
  })

  it('the UI renders the withheld notice instead of the figure cards', () => {
    const src = read('components/order-history/order-history-content.tsx')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    expect(code).toMatch(/data\?\.preLaunch \?/)
    expect(code).toMatch(/REPORTING_COPY\.preLaunchTitle/)
  })
})
