/**
 * @jest-environment jsdom
 *
 * Issue #175 — the card must show the table number.
 *
 * A merchant hit "Table 1 already exists" with no Table 1 on screen. One reason was that the
 * card rendered `orderingPointDisplayName` and nothing else: a custom name is returned as-is
 * (lib/tables/ordering-points.ts:44-45), so for the E2E fixtures named
 * `cash-settle-1785...-t9761` the numbers 9761/9895/9903 appeared NOWHERE in the UI. The error
 * named a number the merchant had no way to see.
 *
 * Asserts on the RENDERED card, not on a formatting helper, because the helper being correct
 * says nothing about whether the number reaches the screen.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// The card is a leaf that takes props only, but its module transitively imports the browser
// Supabase client, which constructs itself at import time and needs NEXT_PUBLIC_* env. Stub it
// so this stays a rendering test and does not become an environment test.
jest.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({}),
  supabase: {},
}))

import { OrderingPointCard } from '@/components/qr-code-management'
import type { OrderingPointRow } from '@/lib/tables/ordering-points'

const noop = () => {}

/**
 * Returns both the card's visible text and the text of the number element specifically.
 *
 * Asserting the number with a \b...\b regex over the whole card does NOT work: textContent
 * concatenates siblings with no separator, so "9761" is immediately followed by "No location
 * set" and there is no word boundary. Reading the dedicated element avoids a test that fails
 * for reasons unrelated to what it is checking.
 */
function renderCardParts(point: Partial<OrderingPointRow>): { text: string; numberText: string } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <OrderingPointCard
        point={
          {
            id: 'p1',
            table_number: 9761,
            table_name: null,
            location: null,
            capacity: null,
            qr_code_url: null,
            is_kiosk: false,
            is_view_only: false,
            active: true,
            ...point,
          } as OrderingPointRow
        }
        restaurantId="r1"
        liveStatus="empty"
        copiedLinkId={null}
        onCopyLink={noop}
        onEdit={noop}
        onDeactivate={noop}
      />,
    )
  })

  const text = container.textContent ?? ''
  const numberEl = container.querySelector('[title^="Table number"]')
  const numberText = numberEl?.textContent ?? ''

  act(() => root.unmount())
  container.remove()
  return { text, numberText }
}

describe('#175 the card shows the table number', () => {
  test('a custom-named dining table still shows its number', () => {
    // The exact staging case: the name hides the number completely.
    const { text, numberText } = renderCardParts({
      table_number: 9761,
      table_name: 'cash-settle-1785593635133-t9761',
    })
    expect(text).toContain('cash-settle-1785593635133-t9761')
    expect(numberText).toContain('9761')
  })

  test('a deactivated table shows its number too — this is the one that causes the collision', () => {
    const { numberText } = renderCardParts({
      table_number: 1,
      table_name: 'Table 1',
      active: false,
    })
    expect(numberText).toContain('1')
  })

  test('the number is shown for a table whose name does not contain it', () => {
    // Guards against a false pass where the digits appear only inside the name string.
    const { text, numberText } = renderCardParts({ table_number: 42, table_name: 'Window Booth' })
    expect(text).toContain('Window Booth')
    expect(numberText).toContain('42')
  })

  test('CONTROL: the display name is still rendered', () => {
    // If this ever fails, the tests above are not proving what they claim.
    expect(renderCardParts({ table_number: 7, table_name: 'Patio' }).text).toContain('Patio')
  })

  test('kiosks and view-only points are not given a misleading table number', () => {
    // Their numbers are internal band allocations (5000+/9000+), not something a merchant
    // writes on a table, so surfacing them would be noise.
    const kiosk = renderCardParts({ table_number: 1001, table_name: 'E2E Kiosk', is_kiosk: true })
    expect(kiosk.text).toContain('E2E Kiosk')
    expect(kiosk.numberText).toBe('')

    const viewOnly = renderCardParts({ table_number: 5006, table_name: 'Lobby', is_view_only: true })
    expect(viewOnly.text).toContain('Lobby')
    expect(viewOnly.numberText).toBe('')
  })
})
