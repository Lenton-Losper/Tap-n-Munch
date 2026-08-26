/**
 * #350 — THE DASHBOARD MUST ACTUALLY BE WIRED TO ANY OF THIS.
 *
 * `__tests__/350-realtime-connection-resilience.test.ts` proves the resilience module behaves. That
 * proof is worth nothing on its own: the exact defect being fixed IS a correct, fully-implemented
 * callback that no caller ever passed. `subscribeRestaurantOrdersRealtime` has forwarded `onStatus`
 * since the day it was written and nothing anywhere supplied one. A module that works and is not
 * called is the same outage.
 *
 * WHY A SOURCE ASSERTION. Mounting `OrdersDashboard` needs `useAuth`, `usePermissions`, a live
 * Supabase client and a router before it renders a single node, and the file is `@ts-nocheck` — so
 * a deleted import there is invisible to tsc AND becomes `undefined` under jest without throwing.
 * That is the same reason `order-alert-copy-signed-off.test.ts` asserts on this file's source.
 * `scripts/check-nocheck-imports-resolve.mjs` covers the import half; this covers the call half.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING. The docblocks in that file legitimately name every symbol
 * asserted below, and a grep that matches its own explanation is the trap #173 and the tab
 * back-button both hit.
 */
export {} // module scope

const { readFileSync } = require('fs') as typeof import('fs')
const { join } = require('path') as typeof import('path')

const raw = readFileSync(join(process.cwd(), 'components/orders-dashboard.tsx'), 'utf8')
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('#350 the staff dashboard is wired to the feed-connection layer', () => {
  it('passes onStatus into the orders subscription', () => {
    // The plumbing existed and was unused. This is item 1 of the issue.
    expect(code).toMatch(/subscribeRestaurantOrdersRealtime\(/)
    expect(code).toMatch(/onStatus:\s*\(status\)\s*=>/)
    expect(code).toMatch(/reportFeedChannelStatus\(\s*`orders:\$\{dashboardRestaurantId\}`/)
  })

  it('passes onStatus into the order-requests subscription too', () => {
    expect(code).toMatch(/reportFeedChannelStatus\(\s*`order_requests:\$\{dashboardRestaurantId\}`/)
  })

  it('no longer calls subscribe() on the tabs channel with nothing', () => {
    // `.subscribe()` with no callback at all was how that channel could die unobserved.
    expect(code).not.toMatch(/\.subscribe\(\)/)
    expect(code).toMatch(/reportFeedChannelStatus\(`tabs:\$\{restaurantUuid\}`,\s*status\)/)
  })

  it('REFETCHES on the reconnect flag rather than only resubscribing', () => {
    // The load-bearing half of the whole issue. A socket that comes back does not backfill the
    // Postgres changes it missed, so a resubscribe with no refetch leaves the list permanently
    // short of a window of orders while every indicator says it is fine.
    const refetchOrders = /if\s*\(refetch\)\s*void refreshOpenOrders\(\)/g
    expect(code.match(refetchOrders)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(code).toMatch(/if\s*\(refetch\)\s*void refreshWaitingRequests\(\)/)
  })

  it('has a refetch that really re-reads the list from the database', () => {
    // Not just a state poke: the refetch must go back to the source.
    const body = code.slice(code.indexOf('const refreshOpenOrders'))
    expect(body.slice(0, 900)).toMatch(/getAllOpenRestaurantOrders\(/)
    expect(body.slice(0, 900)).toMatch(/setAllOrders\(/)
  })

  it('installs the visibility / poll fallbacks', () => {
    // Items 3 and 4. A tab left open overnight is the normal case for this screen.
    expect(code).toMatch(/startFeedFallback\(\{/)
    expect(code).toMatch(/void refreshOpenOrders\(\)/)
  })

  it('registers and unregisters each channel it depends on', () => {
    expect(code.match(/registerFeedChannel\(/g)?.length ?? 0).toBe(3)
    expect(code).toMatch(/unregisterChannel\?\.\(\)/)
    expect(code).toMatch(/unregister\(\)/)
  })

  it('renders the connection indicator in the header, beside the sound indicator', () => {
    // Item 5, to the standard the sound indicator set: staff can see whether the thing works.
    expect(code).toMatch(/<OrderAlertIndicator \/>\s*<FeedConnectionIndicator \/>/)
  })

  it('subscribes the indicator rather than reading the state once', () => {
    // An indicator that went stale would be lying about the one thing it exists to report.
    const component = code.slice(code.indexOf('function FeedConnectionIndicator'))
    expect(component.slice(0, 600)).toMatch(/subscribeFeedConnectionState\(sync\)/)
  })

  it('still only ticks the clock on the 60s interval — the refetch is a separate schedule', () => {
    // Merging the two would make the cheap clock tick as expensive as a full list read.
    expect(code).toMatch(/window\.setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 60_000\)/)
  })
})
