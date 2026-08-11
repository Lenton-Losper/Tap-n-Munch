/**
 * @jest-environment jsdom
 *
 * #207 — a toast fired from a MOUNT EFFECT was silently dropped.
 *
 * `hooks/use-toast.ts` seeded its local state from the module-level `memoryState` at RENDER time
 * and only subscribed to the store in an effect:
 *
 *     const [state, setState] = React.useState<State>(memoryState)   // captured at render
 *     React.useEffect(() => { listeners.push(setState) }, [state])   // subscribed later
 *
 * React runs effects in child order and `<Toaster />` is the LAST child of AppProviders, so a
 * toast dispatched from an earlier child's mount effect lands in the window between the two:
 * `dispatch` walks a `listeners` array that does not yet contain the Toaster's `setState`, and the
 * Toaster's `useState` initial value was captured before the dispatch and is never re-read. The
 * message sits in the store with nothing subscribed that can see it, and nothing raises an error.
 *
 * Latent when filed — all 17 customer-facing call sites enumerated in #204 fire from event
 * handlers. The trigger is any future "tell the customer something on arrival" message: a
 * session-expired notice on redirect, a failed-payment message on return from a provider. Those
 * are natural things to reach for and they would have failed silently.
 *
 * WHY THE ORDERING IS ASSERTED DIRECTLY RATHER THAN THROUGH AppProviders. The defect is about
 * WHEN the viewport subscribes relative to when a sibling dispatches, so the test renders the two
 * as bare siblings. Routing it through the provider tree would add three mocks and measure the
 * same thing less precisely -- and #207 was FOUND by a test whose provider harness made a
 * one-sided reading look like proof.
 *
 * The click-handler case is asserted too, and it passed before this fix as well as after. That is
 * the control: it is what shows the fix did not simply make every toast work by making the
 * component render more, and it is the path every real call site uses today.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster } from '@/components/ui/toaster'
import { toast } from '@/hooks/use-toast'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Fires a toast from its own mount effect — an "on arrival" message. */
function FiresOnMount({ text }: { text: string }) {
  React.useEffect(() => {
    toast({ title: 'On arrival', description: text })
  }, [text])
  return null
}

/** Fires a toast from a click — what every real call site does today. */
function FiresOnClick({ text }: { text: string }) {
  return (
    <button type="button" onClick={() => toast({ title: 'From a click', description: text })}>
      fire
    </button>
  )
}

describe('a toast dispatched before the viewport subscribes', () => {
  it('reaches the DOM when fired from a mount effect', () => {
    const text = 'your session has ended — scan the QR code again'

    act(() => {
      root.render(
        <>
          <FiresOnMount text={text} />
          <Toaster />
        </>,
      )
    })

    expect(document.body.textContent).toContain(text)
  })

  it('renders it exactly once', () => {
    const text = 'rendered once from a mount effect'

    act(() => {
      root.render(
        <>
          <FiresOnMount text={text} />
          <Toaster />
        </>,
      )
    })

    const hits = document.body.textContent?.split(text).length ?? 0
    expect(hits - 1).toBe(1)
  })
})

describe('the control — the path every real call site uses', () => {
  it('still reaches the DOM when fired from a click handler', () => {
    const text = 'could not add to tab'

    act(() => {
      root.render(
        <>
          <FiresOnClick text={text} />
          <Toaster />
        </>,
      )
    })

    expect(document.body.textContent).not.toContain(text)

    const button = container.querySelector('button')
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(text)
  })
})
