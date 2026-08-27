/**
 * @jest-environment jsdom
 *
 * The "clear all" control on the Held for review panel, asserted against the MOUNTED component.
 *
 * WHY THE DOM AND NOT THE PROPS. #306 shipped a fix that was inert because the route wrote a column
 * it never selected — tsc and the unit tests were both blind to it. A control whose confirmation
 * never renders, or whose per-order result lines render as an empty list, fails in exactly that
 * shape: every function returns the right value and the staff member sees nothing. So these read
 * `container.textContent` and the rendered `data-outcome` attributes.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is `never lets a gateway outage render as "none of these were
 * paid"`. Two summaries with the SAME six untouched orders — one where the gateway was down, one
 * where it answered — must not produce the same screen.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { HeldForReviewPanel } from '@/components/held-for-review-panel'
import { buildHeldForReviewRow, type HeldForReviewRow } from '@/lib/orders/held-for-review'
import {
  CLEAR_HELD_OUTCOMES,
  type ClearHeldOutcome,
  type ClearHeldSummary,
} from '@/lib/orders/clear-held-for-review-outcomes'
import {
  CLEAR_HELD_CONTROL_COPY,
  CLEAR_HELD_OUTCOME_COPY,
  CLEAR_HELD_PENDING_COPY_MARKER,
} from '@/lib/orders/clear-held-for-review-copy'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

let container: HTMLDivElement
let root: Root

async function mount(node: React.ReactElement) {
  await act(async () => {
    root.render(node)
  })
}

function text(): string {
  return container.textContent ?? ''
}

function el(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`)
}

async function click(testId: string) {
  const node = el(testId)
  if (!node) throw new Error(`no element with data-testid="${testId}"`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

const HELD_ROWS: HeldForReviewRow[] = [435, 462, 494, 523, 548, 615].map((n) =>
  buildHeldForReviewRow(
    {
      id: `o-${n}`,
      payment_status: 'pending',
      placed_at: daysAgo(8),
      total: 52.5,
      table_number: 0,
      channel: 'pos',
      paycloud_merchant_order_no: `FT-o-${n}`,
    },
    'stranded_pending',
    NOW,
  ),
)

function summary(
  outcomes: Array<{ id: string; outcome: ClearHeldOutcome; code?: string; wrote?: boolean }>,
  extra: Partial<ClearHeldSummary> = {},
): ClearHeldSummary {
  const counts = Object.fromEntries(CLEAR_HELD_OUTCOMES.map((o) => [o, 0])) as Record<
    ClearHeldOutcome,
    number
  >
  for (const o of outcomes) counts[o.outcome] += 1
  return {
    startedAt: '2026-08-27T12:00:00.000Z',
    finishedAt: '2026-08-27T12:00:05.000Z',
    requestedBy: 'user-1',
    venues: [
      {
        restaurantId: 'rest-mingle',
        control: {
          orderId: 'o-678',
          orderNumber: 678,
          verdict: 'passed',
          asks: outcomes.length,
          markerless: true,
          lastGatewayCode: 'PAID',
          note: null,
        },
        orderIds: outcomes.map((o) => o.id),
      },
    ],
    outcomes: outcomes.map((o, i) => ({
      orderId: o.id,
      restaurantId: 'rest-mingle',
      orderNumber: 400 + i,
      total: 52.5,
      channel: 'pos',
      cause: 'stranded_pending',
      outcome: o.outcome,
      gatewayCode: o.code ?? 'E04111',
      gatewayStatus: null,
      gatewayAmount: null,
      gatewayAskedAt: '2026-08-27T12:00:01.000Z',
      gatewayNote: null,
      controlVerdict: 'passed',
      wrote: o.wrote ?? o.outcome === 'cancelled',
    })),
    counts,
    cancelledIds: outcomes.filter((o) => o.outcome === 'cancelled').map((o) => o.id),
    paidIds: [],
    heldForAmountReviewIds: [],
    unverifiableIds: [],
    skippedIds: [],
    gatewayAsks: outcomes.length * 2,
    gatewayAsksFailed: 0,
    allGatewayCallsFailed: false,
    ...extra,
  }
}

describe('who sees the control', () => {
  it('is absent without orders:update, even though the rows are on screen', async () => {
    await mount(
      <HeldForReviewPanel rows={HELD_ROWS} onClearAll={() => {}} canClearAll={false} />,
    )
    expect(el('held-for-review')).not.toBeNull()
    expect(el('held-clear-control')).toBeNull()
    expect(el('held-clear-button')).toBeNull()
  })

  it('is absent when the caller wired no handler at all', async () => {
    await mount(<HeldForReviewPanel rows={HELD_ROWS} canClearAll />)
    expect(el('held-clear-control')).toBeNull()
  })

  it('is present with the permission, and renders the SIGNED button copy with no marker left on it', async () => {
    /**
     * WAS "every word of it is marked unsigned". The owner signed this string on 2026-08-27, so the
     * assertion inverts: the marker must be GONE and the signed sentence must be what renders.
     *
     * Both halves, because either alone is satisfiable by an accident. "No marker" passes on an
     * empty button; "contains the copy" passes on a button that also still says PENDING COPY.
     */
    await mount(<HeldForReviewPanel rows={HELD_ROWS} onClearAll={() => {}} canClearAll />)
    const button = el('held-clear-button')
    expect(button).not.toBeNull()
    expect(button!.textContent).toBe(CLEAR_HELD_CONTROL_COPY.button)
    expect(button!.textContent).not.toContain(CLEAR_HELD_PENDING_COPY_MARKER)
  })
})

describe('the confirmation', () => {
  it('does not run the action on the first click, and states the blast radius', async () => {
    const calls: number[] = []
    await mount(
      <HeldForReviewPanel
        rows={HELD_ROWS}
        onClearAll={() => { calls.push(1) }}
        canClearAll
        currency="N$"
      />,
    )
    await click('held-clear-button')
    expect(calls).toHaveLength(0)

    const body = el('held-clear-confirm-body')!
    // the COUNT and the AMOUNT, so the staff member sees what is about to be touched
    expect(body.textContent).toContain('6')
    expect(body.textContent).toContain('N$315.00')
    // SIGNED 2026-08-27, so the marker must be gone from what a staff member reads.
    expect(body.textContent).not.toContain(CLEAR_HELD_PENDING_COPY_MARKER)
    // the placeholders were substituted, not rendered raw
    expect(body.textContent).not.toContain('{count}')
    expect(body.textContent).not.toContain('{amount}')
  })

  it('runs it on the second click, and backing out runs nothing', async () => {
    const calls: number[] = []
    await mount(
      <HeldForReviewPanel rows={HELD_ROWS} onClearAll={() => { calls.push(1) }} canClearAll />,
    )
    await click('held-clear-button')
    await click('held-clear-confirm-cancel')
    expect(calls).toHaveLength(0)
    expect(el('held-clear-button')).not.toBeNull()

    await click('held-clear-button')
    await click('held-clear-confirm-accept')
    expect(calls).toHaveLength(1)
  })

  it('offers nothing to press while a run is in flight', async () => {
    await mount(
      <HeldForReviewPanel rows={HELD_ROWS} onClearAll={() => {}} canClearAll clearing />,
    )
    expect(el('held-clear-button')).toBeNull()
    expect(el('held-clear-confirm-accept')).toBeNull()
    expect(el('held-clear-running')!.textContent).toBe(CLEAR_HELD_CONTROL_COPY.running)
  })
})

describe('the result', () => {
  it('names what happened to EACH order, not just how many', async () => {
    await mount(
      <HeldForReviewPanel
        rows={HELD_ROWS}
        onClearAll={() => {}}
        canClearAll
        clearSummary={summary([
          { id: 'o-435', outcome: 'cancelled' },
          { id: 'o-462', outcome: 'gateway_confirmed_paid', code: 'PAID', wrote: true },
          { id: 'o-494', outcome: 'skipped_gateway_unreachable', code: 'GATEWAY_ERROR' },
          { id: 'o-523', outcome: 'unverifiable_no_credentials', code: 'NO_CREDENTIALS' },
          { id: 'o-548', outcome: 'skipped_gateway_status_unrecognised', code: '7' },
          { id: 'o-615', outcome: 'skipped_already_resolved', code: 'NOT_ASKED' },
        ])}
      />,
    )
    const lines = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="held-clear-result-row"]'),
    )
    expect(lines).toHaveLength(6)
    expect(lines.map((l) => l.dataset.outcome)).toEqual([
      'cancelled',
      'gateway_confirmed_paid',
      'skipped_gateway_unreachable',
      'unverifiable_no_credentials',
      'skipped_gateway_status_unrecognised',
      'skipped_already_resolved',
    ])
    // the FRESH gateway code, on each line, where a person can read it
    expect(lines.map((l) => l.dataset.gatewayCode)).toEqual([
      'E04111',
      'PAID',
      'GATEWAY_ERROR',
      'NO_CREDENTIALS',
      '7',
      'NOT_ASKED',
    ])
    // and each carries its own sentence, not a shared one
    for (const line of lines) {
      const outcome = line.dataset.outcome as ClearHeldOutcome
      expect(line.textContent).toContain(CLEAR_HELD_OUTCOME_COPY[outcome])
    }
    expect(new Set(lines.map((l) => l.textContent)).size).toBe(6)
  })

  it('never renders "#0" for an order with no allocated number', async () => {
    /**
     * `0` and `''` both live in `orders.order_number` and both mean "none allocated". A `!= null`
     * test admits them, which is how "Order #0" reached production three times.
     * scripts/check-order-number-guard.ts caught this line statically; this asserts the behaviour.
     */
    const s = summary([{ id: 'o-nonumber', outcome: 'cancelled' }])
    s.outcomes[0].orderNumber = 0
    await mount(
      <HeldForReviewPanel rows={HELD_ROWS} onClearAll={() => {}} canClearAll clearSummary={s} />,
    )
    expect(el('held-clear-result-order')!.textContent).toBe('o-nonumber')
    expect(text()).not.toContain('#0')
  })

  it('never lets a gateway outage render as "none of these were paid"', async () => {
    /**
     * THE TWO RUNS THAT PRODUCE THE SAME UNTOUCHED SIX. Only the banner tells them apart, and this
     * is the assertion that it does.
     */
    const untouched = [
      { id: 'o-435', outcome: 'skipped_control_failed' as ClearHeldOutcome },
      { id: 'o-462', outcome: 'skipped_control_failed' as ClearHeldOutcome },
    ]
    await mount(
      <HeldForReviewPanel
        rows={HELD_ROWS}
        onClearAll={() => {}}
        canClearAll
        clearSummary={summary(untouched, {
          gatewayAsks: 4,
          gatewayAsksFailed: 4,
          allGatewayCallsFailed: true,
        })}
      />,
    )
    const banner = el('held-clear-banner')!
    expect(banner.dataset.banner).toBe('all_gateway_calls_failed')
    expect(banner.textContent).toBe(CLEAR_HELD_CONTROL_COPY.allGatewayCallsFailed)
    // the words that matter: it must say the orders were NOT checked, not that they were unpaid
    expect(banner.textContent!.toLowerCase()).toContain('not')
    expect(text()).not.toContain('none of these were paid')

    // ...and a run that genuinely resolved everything shows no banner at all
    await mount(
      <HeldForReviewPanel
        rows={HELD_ROWS}
        onClearAll={() => {}}
        canClearAll
        clearSummary={summary([{ id: 'o-435', outcome: 'cancelled' }])}
      />,
    )
    expect(el('held-clear-banner')).toBeNull()
  })

  it('keeps a failed REQUEST distinguishable from a run that found nothing to do', async () => {
    await mount(
      <HeldForReviewPanel
        rows={HELD_ROWS}
        onClearAll={() => {}}
        canClearAll
        clearError="clear_run_failed"
      />,
    )
    expect(el('held-clear-request-error')!.textContent).toBe(
      CLEAR_HELD_CONTROL_COPY.requestFailed,
    )
    // the raw server error string is never put in front of a staff member
    expect(text()).not.toContain('clear_run_failed')
    // and no result list is invented for a request that never produced one
    expect(el('held-clear-results')).toBeNull()
  })
})
