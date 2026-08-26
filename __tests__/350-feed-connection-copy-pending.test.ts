/**
 * #350 — THE CONNECTION INDICATOR'S LABELS ARE PLACEHOLDERS, AND MUST BE FINDABLE AS SUCH.
 *
 * Nothing here asserts wording. The three strings are `PENDING COPY - ...` markers awaiting the
 * owner; the assertions exist so the placeholders cannot quietly become permanent, which is exactly
 * what happened to the sound labels — they shipped as markers and staff read them on the Live
 * Orders header across three production deploys.
 *
 * WHEN THE OWNER SIGNS THE WORDING OFF: replace `lib/dashboard/feed-connection-copy.ts` with the
 * verbatim strings, then rewrite this file in the shape of
 * `__tests__/order-alert-copy-signed-off.test.ts` — pinning each string and the
 * two-facts-one-instruction rule. THIS SUITE GOING RED IS THE SIGNAL THAT SOMEONE EDITED THE COPY
 * WITHOUT DOING THAT.
 */
export {} // module scope

import { FEED_CONNECTION_COPY } from '@/lib/dashboard/feed-connection-copy'

const { readFileSync } = require('fs') as typeof import('fs')
const { join } = require('path') as typeof import('path')

describe('#350 feed-connection copy', () => {
  it('covers exactly the three connection states, and no more', () => {
    // Three states for the same reason the sound indicator has three: `offline` is the only one
    // where a staff member has something to do, so it must not collapse into `reconnecting`.
    expect(Object.keys(FEED_CONNECTION_COPY).sort()).toEqual(['live', 'offline', 'reconnecting'])
  })

  it('is still marked PENDING COPY on every state', () => {
    for (const [state, label] of Object.entries(FEED_CONNECTION_COPY)) {
      expect(`${state}: ${label}`).toMatch(/PENDING COPY/)
    }
  })

  it('keeps the placeholders OUT of the dashboard component itself', () => {
    // `order-alert-copy-signed-off.test.ts` asserts that file carries no PENDING COPY marker,
    // because the sound labels were the last placeholders on production. Unsigned wording for a
    // different feature must not be smuggled past that gate by sitting in the same file — it
    // belongs in a copy module, still marked and still greppable.
    const src = readFileSync(join(process.cwd(), 'components/orders-dashboard.tsx'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/PENDING COPY/)
    expect(code).toMatch(/FEED_CONNECTION_COPY\[state\]/)
  })
})
