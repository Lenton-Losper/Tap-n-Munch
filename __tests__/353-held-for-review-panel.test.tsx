/**
 * @jest-environment jsdom
 *
 * #353 — the "Held for review" panel, asserted against the MOUNTED component.
 *
 * WHY THE POPULATED PATH IS THE POINT OF THIS FILE. The only state producible from production
 * data today is the stranded kind: zero orders carry a hold status, so the two signed hold rows
 * have NEVER rendered anywhere. A surface whose non-empty path has never been drawn is untested
 * by construction, and this repo has already shipped a fix that was inert because the route
 * wrote a column it never selected (#306). So the fixtures here drive every cause the surface
 * knows about, and the assertions read the DOM rather than the props.
 *
 * The pinned sentences are asserted HERE TOO, from rendered text. The unit test proves the
 * constant holds them; this one proves a staff member can read them on the screen. Those are
 * different claims, and only the second is the one the owner ruled on.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { HeldForReviewPanel } from '@/components/held-for-review-panel'
import {
  UNSIGNED_COPY_MARKER,
  buildHeldForReviewRow,
  selectHeldForReviewOrders,
  type HeldForReviewCandidate,
  type HeldForReviewRow,
} from '@/lib/orders/held-for-review'

const CARD_MAY_HAVE_BEEN_CHARGED = 'A card may still have been charged on the machine.'
const NOTHING_HAS_BEEN_TAKEN = 'Nothing has been taken from this order yet.'

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

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid="held-for-review-row"]'))
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
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

/**
 * Every cause the surface knows about, in one screen.
 *
 * `verification_unavailable_hold` is built through `buildHeldForReviewRow` rather than through
 * `selectHeldForReviewOrders`, and that is not a shortcut. Its copy is SIGNED, but #153 has not
 * merged, so `HELD_FOR_REVIEW_PAYMENT_STATUSES` does not contain it and NO fixture can make the
 * selector classify it on this branch. The alternative — asserting the pinned sentence only
 * against a constant — would leave the row the owner ruled on having never been drawn. So the
 * cause is supplied by hand and everything downstream of it (copy lookup, row shape, render) is
 * production code. The classification half is covered by 353-held-for-review-copy, which walks
 * whatever the array holds.
 */
/** Rows produced end to end by the selector: every cause this branch can DETECT. */
const SELECTABLE: HeldForReviewCandidate[] = [
  {
    id: 'mismatch-1',
    payment_status: 'amount_mismatch_hold',
    placed_at: daysAgo(1),
    total: 200,
    table_number: 4,
    channel: 'pos',
    paycloud_merchant_order_no: 'MO-200',
  },
  {
    id: 'stranded-1',
    payment_status: 'pending',
    placed_at: daysAgo(35),
    total: 3,
    table_number: 1001,
    channel: 'kiosk',
    /**
     * A payment WAS started on this one, which is what keeps it `stranded_pending` after the
     * 2026-08-28 split. Without a reference it is now `stranded_never_attempted` — a different
     * cause with different copy — and this fixture exists to exercise the SIGNED stranded wording.
     */
    paycloud_merchant_order_no: 'MO-3',
    payment_attempt_started_at: daysAgo(35),
  },
]

/** The signed hold row this branch cannot yet detect. See the note above. */
const UNVERIFIABLE_ROW: HeldForReviewRow = buildHeldForReviewRow(
  {
    id: 'unverifiable-1',
    payment_status: 'verification_unavailable_hold',
    placed_at: daysAgo(2),
    total: 65,
    table_number: 9,
    channel: 'pos',
    paycloud_merchant_order_no: 'MO-65',
  },
  'verification_unavailable_hold',
  NOW,
)

/** The whole screen: everything selectable, plus the row #153 will make selectable. */
function everyCause(): HeldForReviewRow[] {
  return [...selectHeldForReviewOrders(SELECTABLE, NOW), UNVERIFIABLE_ROW].sort(
    (a, b) => (b.heldForMs ?? Infinity) - (a.heldForMs ?? Infinity),
  )
}

describe('#353 the populated panel', () => {
  it('renders one row per held order, oldest first', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    expect(rows()).toHaveLength(3)
    expect(rows().map((r) => r.getAttribute('data-cause'))).toEqual([
      'stranded_pending',
      'verification_unavailable_hold',
      'amount_mismatch_hold',
    ])
  })

  it('renders the signed heading and intro', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    expect(text()).toContain('Held for review')
    expect(
      container.querySelector('[data-testid="held-for-review-intro"]')?.textContent,
    ).toBe(
      'These orders are not paid and are not cancelled. Each one needs a person to decide what happened.',
    )
  })

  it('PINNED: "A card may still have been charged on the machine." reaches the screen', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    const row = rows().find((r) => r.getAttribute('data-cause') === 'verification_unavailable_hold')
    expect(row?.textContent).toContain(CARD_MAY_HAVE_BEEN_CHARGED)
  })

  it('PINNED: "Nothing has been taken from this order yet." reaches the screen', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    const row = rows().find((r) => r.getAttribute('data-cause') === 'amount_mismatch_hold')
    expect(row?.textContent).toContain(NOTHING_HAS_BEEN_TAKEN)
  })

  it('PINNED: the two sentences do not cross rows', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    const mismatch = rows().find((r) => r.getAttribute('data-cause') === 'amount_mismatch_hold')
    const unverifiable = rows().find(
      (r) => r.getAttribute('data-cause') === 'verification_unavailable_hold',
    )
    expect(mismatch?.textContent).not.toContain(CARD_MAY_HAVE_BEEN_CHARGED)
    expect(unverifiable?.textContent).not.toContain(NOTHING_HAS_BEEN_TAKEN)
  })

  it('each row shows what is owed, how long it has been held, and the table', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    const mismatch = rows().find((r) => r.getAttribute('data-cause') === 'amount_mismatch_hold')!
    expect(mismatch.querySelector('[data-testid="held-row-amount"]')?.textContent).toBe('N$200.00')
    expect(mismatch.querySelector('[data-testid="held-row-duration"]')?.textContent).toBe('1 day')
    expect(mismatch.querySelector('[data-testid="held-row-table"]')?.textContent).toBe('Table 4')
  })

  it('uses the venue currency symbol rather than a hard-coded one', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} currency="R" />,
    )
    expect(
      container.querySelector('[data-testid="held-row-amount"]')?.textContent,
    ).toBe('R3.00')
  })

  it('a stranded row renders the SIGNED wording, through the DOM staff actually read', async () => {
    // Inverted 2026-08-27. The previous assertion — that this row shows the unsigned marker — was
    // a deliberate tripwire, and it fired the moment the copy was signed. That is why it is
    // rewritten here rather than deleted.
    //
    // Asserted through the rendered row, not off the constant, because the constant being right
    // and the panel rendering it are two different claims: six of these reached a live venue's
    // dashboard reading `COPY NOT SIGNED (stranded_pending)`, which is what a correct constant
    // with a wrong render looks like from the outside.
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    const stranded = rows().find((r) => r.getAttribute('data-cause') === 'stranded_pending')!
    expect(stranded.getAttribute('data-copy-signed')).toBe('true')
    expect(stranded.textContent).not.toContain(UNSIGNED_COPY_MARKER)
    expect(stranded.textContent).toContain('Payment never confirmed')
    expect(stranded.textContent).toContain('Nothing was taken.')
  })

  it('NO row on the panel shows an unsigned marker, whatever the cause', async () => {
    // The class assertion the per-cause tests cannot make. `everyCause()` builds one row per cause
    // the dashboard can produce, so this fails the day a fourth hold cause is added without
    // wording — before it reaches a venue, rather than after.
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    for (const row of rows()) {
      expect(row.textContent).not.toContain(UNSIGNED_COPY_MARKER)
      expect(row.getAttribute('data-copy-signed')).toBe('true')
    }
  })

  it('the signed rows are marked signed', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} />,
    )
    for (const cause of ['amount_mismatch_hold', 'verification_unavailable_hold']) {
      const row = rows().find((r) => r.getAttribute('data-cause') === cause)!
      expect(row.getAttribute('data-copy-signed')).toBe('true')
      expect(row.textContent).not.toContain(UNSIGNED_COPY_MARKER)
    }
  })
})

describe('#353 the three states are distinguishable', () => {
  it('empty renders nothing at all', async () => {
    await mount(<HeldForReviewPanel rows={[]} loading={false} />)
    expect(container.querySelector('[data-testid="held-for-review"]')).toBeNull()
  })

  it('loading says so, and is not the empty state', async () => {
    await mount(<HeldForReviewPanel rows={[]} loading />)
    expect(
      container.querySelector('[data-testid="held-for-review"]')?.getAttribute('data-state'),
    ).toBe('loading')
  })

  it('a failed read NEVER reads as all clear', async () => {
    // The whole class: "all clear" gets shipped, "it's present" gets verified. An error that
    // renders like an empty list is a false all-clear on a money screen.
    await mount(<HeldForReviewPanel rows={[]} loading={false} error="boom" />)
    const section = container.querySelector('[data-testid="held-for-review"]')
    expect(section?.getAttribute('data-state')).toBe('error')
    expect(container.querySelector('[data-testid="held-for-review-error"]')?.textContent).toBe(
      'This list could not be loaded, so it is not showing whether any orders are held.',
    )
    expect(text()).not.toMatch(/no orders|nothing|all clear/i)
  })

  it('an error while rows are already known keeps showing them', async () => {
    await mount(
      <HeldForReviewPanel rows={everyCause()} loading={false} error="boom" />,
    )
    // The error state wins the render, but the caller keeps the rows in state -- asserted here so
    // a future change that clears them on failure has to argue with a test.
    expect(
      container.querySelector('[data-testid="held-for-review"]')?.getAttribute('data-state'),
    ).toBe('error')
  })
})
