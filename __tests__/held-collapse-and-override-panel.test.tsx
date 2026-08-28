/**
 * @jest-environment jsdom
 *
 * The collapse, and the per-order override control.
 *
 * TWO PROPERTIES THAT PULL AGAINST EACH OTHER, asserted together because that is the only way to
 * keep both:
 *
 *   1. Eight identical cards is not information -- so the list collapses to a summary line.
 *   2. #353: an UNSIGNED string must be impossible to miss -- that guarantee exists because on
 *      2026-08-21 five of them reached production and the owner of a multi-location account read
 *      `PENDING COPY — Location` on twenty staff screens.
 *
 * A collapse that folds unsigned wording behind a tap re-creates (2) SILENTLY: the marker stays in
 * the DOM, stays greppable, still passes `check-no-pending-copy.mjs`, and is simply not on screen.
 * So the collapse yields when the two conflict, and this suite pins that.
 *
 * Rendered through `createRoot` + `act`, matching 353-held-for-review-panel, so both suites drive
 * the component the same way.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { HeldForReviewPanel } from '@/components/held-for-review-panel'
import { OVERRIDE_CANCEL_COPY } from '@/lib/orders/override-cancel-copy'
import type { HeldForReviewRow } from '@/lib/orders/held-for-review'

let container: HTMLDivElement
let root: Root

async function mount(node: React.ReactElement) {
  await act(async () => {
    root.render(node)
  })
}

async function click(el: Element | null) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const q = (sel: string) => container.querySelector(`[data-testid="${sel}"]`)
const qa = (sel: string) => Array.from(container.querySelectorAll(`[data-testid="${sel}"]`))

function row(over: Partial<HeldForReviewRow>): HeldForReviewRow {
  return {
    id: 'a',
    cause: 'stranded_pending',
    label: 'Order #41',
    total: 147,
    heldForMs: 3 * 3_600_000,
    table: 4,
    why: 'The provider has no record of this order.',
    copySigned: true,
    ...over,
  } as HeldForReviewRow
}

const signedRows = [
  row({ id: 'a', label: 'Order #41', total: 147, heldForMs: 3 * 3_600_000 }),
  row({ id: 'b', label: 'Order #42', total: 1_029, heldForMs: 9 * 24 * 3_600_000 }),
]

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

describe('the collapse', () => {
  it('shows a summary line: count, amount, and the age of the OLDEST', async () => {
    await mount(<HeldForReviewPanel rows={signedRows} />)

    expect(q('held-summary-count')?.textContent).toBe('2')
    /**
     * Through `heldAmountDigits`, the formatter the rows already use -- so the summary and the
     * cards below it cannot disagree about the same money. It renders 1176.00 rather than 1,176;
     * a second formatter on a money surface is how one screen ends up showing two totals.
     */
    expect(q('held-summary-total')?.textContent).toContain('1176')
    // The OLDEST, not an average -- an average hides the one ignored longest behind fresh ones.
    expect(q('held-summary-oldest')?.textContent).toContain('9')
  })

  it('hides the detail until it is tapped, and opens on the tap', async () => {
    await mount(<HeldForReviewPanel rows={signedRows} />)

    expect(q('held-for-review-summary')?.getAttribute('aria-expanded')).toBe('false')
    await click(q('held-for-review-summary'))
    expect(q('held-for-review-summary')?.getAttribute('aria-expanded')).toBe('true')
  })

  /** The guarantee the collapse must not break. */
  it('OPENS BY DEFAULT when any row carries unsigned copy', async () => {
    await mount(<HeldForReviewPanel rows={[row({ id: 'c', copySigned: false })]} />)

    expect(q('held-for-review-summary')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('stays collapsed when every row is signed', async () => {
    await mount(<HeldForReviewPanel rows={signedRows} />)
    expect(q('held-for-review-summary')?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the per-order override', () => {
  it('is absent without the permission, whatever the handler', async () => {
    await mount(
      <HeldForReviewPanel rows={signedRows} onOverrideCancel={jest.fn()} canOverride={false} />,
    )
    expect(q('held-row-override-start')).toBeNull()
  })

  it('is absent without a handler, even with the permission', async () => {
    await mount(<HeldForReviewPanel rows={signedRows} canOverride />)
    expect(q('held-row-override-start')).toBeNull()
  })

  it('renders one control per order, with the signed label', async () => {
    await mount(<HeldForReviewPanel rows={signedRows} onOverrideCancel={jest.fn()} canOverride />)
    await click(q('held-for-review-summary'))

    const controls = qa('held-row-override-start')
    expect(controls).toHaveLength(2)
    expect(controls[0].textContent).toBe(OVERRIDE_CANCEL_COPY.button)
  })

  /**
   * TWO-STEP, and the first click must not act. This cancel may be destroying the record of a real
   * charge; the confirmation is the last point at which a person can stop.
   */
  it('does NOT act on the first click, and states the risk on the second step', async () => {
    const onOverrideCancel = jest.fn()
    await mount(
      <HeldForReviewPanel rows={signedRows} onOverrideCancel={onOverrideCancel} canOverride />,
    )
    await click(q('held-for-review-summary'))

    await click(qa('held-row-override-start')[0])
    expect(onOverrideCancel).not.toHaveBeenCalled()

    // The sentence the owner pinned by name reaches the screen.
    expect(q('held-row-override-confirm-body')?.textContent).toContain(
      'The card may have been charged.',
    )

    await click(q('held-row-override-accept'))
    expect(onOverrideCancel).toHaveBeenCalledWith('a')
  })

  it('confirms ONE order, not all of them', async () => {
    await mount(<HeldForReviewPanel rows={signedRows} onOverrideCancel={jest.fn()} canOverride />)
    await click(q('held-for-review-summary'))
    await click(qa('held-row-override-start')[0])

    expect(qa('held-row-override-confirm')).toHaveLength(1)
    // The other card still offers its own control -- this is a per-order decision.
    expect(qa('held-row-override-start')).toHaveLength(1)
  })

  /**
   * THE REFUSAL HAS TO REACH THE SCREEN. "The provider now says this is PAID, so I did not cancel
   * it" is the most important thing this control can say, and a refusal rendered as a generic
   * failure is a member of staff concluding the button is broken and pressing it again.
   */
  it('renders the refusal against the order it belongs to, and only that one', async () => {
    await mount(
      <HeldForReviewPanel
        rows={signedRows}
        onOverrideCancel={jest.fn()}
        canOverride
        overrideMessages={{
          a:
            'The payment provider now reports this order as PAID, so it has not been cancelled. ' +
            'Refund it instead if the customer is owed money.',
        }}
      />,
    )
    await click(q('held-for-review-summary'))

    const messages = qa('held-row-override-message')
    expect(messages).toHaveLength(1)
    expect(messages[0].textContent).toContain('has not been cancelled')
  })
})
