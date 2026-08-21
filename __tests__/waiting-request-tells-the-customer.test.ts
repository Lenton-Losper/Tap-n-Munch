import { readFileSync } from 'fs'
import { join } from 'path'

import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'

/**
 * #311, ruled B on 2026-08-21: a customer waiting on an unanswered request is TOLD how long.
 *
 * ASSERTED AGAINST SOURCE, not against a rendered banner. `components/ActiveOrderBanner.tsx` is
 * `// @ts-nocheck`, so `tsc` covers none of it — a typo in this render site would ship green. That
 * is the specific hole this file exists to cover, and it is why the assertions below read the file
 * rather than trusting the compiler.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: that the record changes. It does not. B was ruled alone —
 * C (customer withdraws) has no status to write, because the CHECK is
 * (waiting_review, accepting, accepted, declined), and D (auto-expire) is blocked behind #215.
 * A test that expected a status transition here would be encoding a decision nobody made.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('#311 — the waiting customer is told how long', () => {
  const src = read('components/ActiveOrderBanner.tsx')
  // Strip comments: the docblocks here explain the rule at length, and a source scan that matches
  // the explanation instead of the code is the failure mode #205 recorded.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /**
   * RETARGETED 2026-08-21. This asserted the string still said `PENDING COPY`, as a tripwire so an
   * unsigned string could not reach production unnoticed -- the exact defect the switcher hit. It
   * is signed off now, so it pins the signed wording instead. Retargeted rather than deleted: the
   * job is the same either way, which is that nobody changes this label without a human deciding to.
   */
  it('carries the signed-off wording, lowercase, with the {minutes} slot intact', () => {
    expect(QR_REDESIGN_PENDING_COPY.waitingForRestaurantElapsed).toBe('waiting {minutes} min')
    expect(QR_REDESIGN_PENDING_COPY.waitingForRestaurantElapsed).not.toMatch(/PENDING COPY/)
    // Lowercase is a ruling, not a style accident: it appends after a separator to an existing
    // sentence in the same <p>, so a capital would start a sentence mid-line. Verified at the
    // render site before signing.
    expect(QR_REDESIGN_PENDING_COPY.waitingForRestaurantElapsed[0]).toBe('w')
  })

  it('the waiting_review branch renders the elapsed copy', () => {
    expect(code).toMatch(/waiting_review/)
    expect(code).toMatch(/QR_REDESIGN_PENDING_COPY\.waitingForRestaurantElapsed/)
    expect(code).toMatch(/\{minutes\}/)
  })

  it('computes the wait from placed_at, not from a client-side guess', () => {
    // The order row carries placed_at (lib/guest-orders/queries.ts maps it). Anything else --
    // first-render time, a mount timestamp -- would reset to zero whenever the banner remounted
    // and would under-report exactly the long waits this issue is about.
    expect(code).toMatch(/currentOrder\.placed_at/)
  })

  it('suppresses the figure under a minute rather than showing "0 min"', () => {
    // A banner that reads "0 min" the instant an order is placed looks like a stall, not a wait.
    expect(code).toMatch(/waitedMin\s*>=\s*1/)
  })

  it('ticks on its own clock, not on the order poll', () => {
    // GUEST_ORDER_POLL_MS asks whether the ORDER changed. The elapsed figure only needs to know
    // what time it is, which is local; coupling them would either freeze the number between polls
    // or add network calls to update something already known.
    expect(code).toMatch(/setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 60_000\)/)
    expect(code).toMatch(/clearInterval/)
  })
})
