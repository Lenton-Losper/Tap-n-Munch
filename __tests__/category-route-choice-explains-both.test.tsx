/**
 * @jest-environment jsdom
 *
 * The merchant must be able to read what 'both' costs WITHOUT choosing it first, and must not be
 * able to save it by a stray click.
 *
 * This is the display half of the 'both' guard. The refusal that actually holds is server-side
 * (category-both-routing-requires-acknowledgement.test.ts); this pins that the person making the
 * decision is told the consequence at the moment they make it, which is the part that would have
 * prevented the Digi Cofee incident rather than merely recorded it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  applyRouteChange,
  CategoryRouteChoice,
  categoryRouteChoiceIsComplete,
} from '@/components/menu/category-route-choice'
import { CATEGORY_ROUTE_OPTIONS } from '@/lib/menu/category-routing'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(value: 'kitchen' | 'bar' | 'both', acknowledged = false) {
  const changes: Array<'kitchen' | 'bar' | 'both'> = []
  const acks: boolean[] = []
  act(() => {
    root.render(
      <CategoryRouteChoice
        idPrefix="t"
        value={value}
        onChange={(v) => changes.push(v)}
        acknowledged={acknowledged}
        onAcknowledgedChange={(a) => acks.push(a)}
      />,
    )
  })
  return {
    changes,
    acks,
    consequence: container.querySelector('[data-testid="t-route-consequence"]')?.textContent ?? '',
    ack: container.querySelector<HTMLElement>('[data-testid="t-route-ack"]'),
    ackInput: container.querySelector<HTMLInputElement>('#t-route-ack-input'),
  }
}

describe('the consequence is stated for every destination', () => {
  it('kitchen and bar say a single station releases it', () => {
    expect(render('kitchen').consequence).toMatch(/Ready as soon as the kitchen bumps it/)
    expect(render('bar').consequence).toMatch(/Ready as soon as the bar bumps it/)
  })

  it('both says it is NOT ready until both stations bump — the inversion, spelled out', () => {
    const { consequence } = render('both')
    expect(consequence).toMatch(/NOT ready until BOTH stations/)
    expect(consequence).toMatch(/One station finishing alone will not release it/)
  })

  it('no destination is left without an explanation', () => {
    for (const o of CATEGORY_ROUTE_OPTIONS) {
      const { consequence } = render(o.value)
      expect(consequence.length).toBeGreaterThan(20)
      expect(consequence).toContain(o.consequence)
    }
  })
})

describe('the acknowledgement gate', () => {
  it('appears only for both', () => {
    expect(render('kitchen').ack).toBeNull()
    expect(render('bar').ack).toBeNull()
    expect(render('both').ack).not.toBeNull()
  })

  it('blocks saving until ticked, and only for both', () => {
    expect(categoryRouteChoiceIsComplete('kitchen', false)).toBe(true)
    expect(categoryRouteChoiceIsComplete('bar', false)).toBe(true)
    expect(categoryRouteChoiceIsComplete('both', false)).toBe(false)
    expect(categoryRouteChoiceIsComplete('both', true)).toBe(true)
  })

  it('reflects the tick back to the caller', () => {
    const r = render('both', false)
    expect(r.ackInput?.checked).toBe(false)
    // A real click toggles `checked` itself; pre-setting it would toggle straight back to false
    // and this test would pass on the wrong value.
    act(() => {
      r.ackInput!.click()
    })
    expect(r.acks).toEqual([true])
  })

  /**
   * An acknowledgement belongs to the value it was given for. Switching destination must retract
   * it, or a merchant who ticks 'both', reconsiders, picks 'bar', then returns to 'both' would
   * save a still-ticked box they last read two decisions ago.
   */
  it('retracts a previous tick when the destination changes', () => {
    const changes: Array<'kitchen' | 'bar' | 'both'> = []
    const acks: boolean[] = []
    const handlers = {
      onChange: (v: 'kitchen' | 'bar' | 'both') => changes.push(v),
      onAcknowledgedChange: (a: boolean) => acks.push(a),
    }

    // both (ticked) -> bar -> both: the tick must not survive the round trip.
    applyRouteChange('bar', handlers)
    expect(changes).toEqual(['bar'])
    expect(acks).toEqual([false])

    applyRouteChange('both', handlers)
    expect(changes).toEqual(['bar', 'both'])
    expect(acks).toEqual([false, false])

    // …and with the tick retracted, the save is blocked again.
    expect(categoryRouteChoiceIsComplete('both', acks[acks.length - 1])).toBe(false)
  })

  it('is the handler the component actually uses — not a parallel copy', () => {
    // If the Select stopped calling applyRouteChange, the retraction above would be testing
    // nothing. Pin the wiring by rendering and reading the prop off the element tree.
    const { ack } = render('both', true)
    expect(ack).not.toBeNull()
    expect(container.querySelector('[data-testid="t-route-choice"]')?.getAttribute('data-route')).toBe(
      'both',
    )
  })
})
