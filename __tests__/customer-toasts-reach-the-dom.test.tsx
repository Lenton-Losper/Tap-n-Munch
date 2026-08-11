/**
 * @jest-environment jsdom
 *
 * #204 — every toast() on a customer route was a no-op.
 *
 * `<Toaster />` (the Radix viewport that actually paints a toast) was mounted in exactly one
 * place in the repository: components/dashboard/dashboard-shell.tsx, the admin shell. No route
 * under app/menu/** is a descendant of that shell, so `useToast().toast(...)` on the cart, tab
 * and order-secure pages dispatched into hooks/use-toast.ts's module-global store and nothing
 * ever rendered it. It type-checks, it lints, and it does nothing.
 *
 * Two things have to hold at once, which is why this file asserts both:
 *
 *   1. A toast fired anywhere under AppProviders — i.e. any customer route — reaches the DOM.
 *   2. The admin toasts that already worked still render, and render EXACTLY ONCE.
 *
 * (2) is not ceremony. hooks/use-toast.ts:129-138 keeps ONE module-level `listeners` array and
 * ONE `memoryState`; every mounted `<Toaster />` subscribes to that same store and renders the
 * same `toasts` array. Two mounts therefore paint the same message twice, in two fixed-position
 * viewports at the same coordinates. Every app/(staff)/** route sits under both AppProviders and
 * DashboardShell, so adding the app-wide mount without removing the shell's own would have
 * doubled every existing admin toast. The exact-once assertion is what catches that.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

let pathname = '/menu/riviera/cart'

jest.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

// AppProviders pulls the auth provider in through next/dynamic. Neither it nor the cart context
// is under test here; both are passthroughs so the only thing this file can be measuring is
// whether a toast viewport exists in the tree.
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/contexts/cart-context', () => ({
  CartProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/components/dashboard/dashboard-sidebar', () => ({
  DashboardSidebar: () => null,
}))
jest.mock('@/components/dashboard/setup-checklist-banner', () => ({
  SetupChecklistBanner: () => null,
}))

import { AppProviders } from '@/app/providers'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { useToast } from '@/hooks/use-toast'

/**
 * Fires one toast from a click handler, which is how every real call site fires one.
 *
 * Deliberately NOT fired from a mount effect: hooks/use-toast.ts:174 has `<Toaster />` subscribe
 * to the store in its own effect, and effects run in child order, so a toast dispatched during
 * mount can land before the viewport is listening and be lost. That is a real (separate) sharp
 * edge in the hook, but it is not what #204 is about, and firing on mount would make this file
 * fail for the wrong reason.
 */
function FiresAToast({ title }: { title: string }) {
  const { toast } = useToast()
  return (
    <button data-testid="fire" onClick={() => toast({ title })}>
      fire
    </button>
  )
}

let container: HTMLDivElement
let root: Root

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui)
  })
}

function fireTheToast() {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="fire"]')
  if (!button) throw new Error('harness did not render — the tree failed to mount')
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** How many times `text` appears in the rendered document. */
function occurrences(text: string): number {
  return Array.from(document.body.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent === text,
  ).length
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('#204 — customer routes have a toast viewport', () => {
  it('renders a toast fired from a route inside AppProviders', () => {
    pathname = '/menu/riviera/cart'
    render(
      <AppProviders>
        <FiresAToast title="Could not add to tab" />
      </AppProviders>,
    )
    fireTheToast()

    expect(occurrences('Could not add to tab')).toBe(1)
  })

  it('renders a toast on the public-marketing branch of AppProviders too', () => {
    // AppProviders returns early for '/' and '/contact' (app/providers.tsx:27). A viewport that
    // only exists on the other side of that branch is a second silent no-op waiting to happen.
    pathname = '/'
    render(
      <AppProviders>
        <FiresAToast title="Marketing route toast" />
      </AppProviders>,
    )
    fireTheToast()

    expect(occurrences('Marketing route toast')).toBe(1)
  })
})

describe('#204 — the admin shell keeps exactly one toast viewport', () => {
  it('renders a dashboard toast once, not zero times and not twice', () => {
    pathname = '/orders'
    render(
      <AppProviders>
        <DashboardShell>
          <FiresAToast title="Menu item saved" />
        </DashboardShell>
      </AppProviders>,
    )
    fireTheToast()

    // 0 => the app-wide mount displaced the admin one.
    // 2 => double-mount; one shared store, two viewports, the same message painted twice.
    expect(occurrences('Menu item saved')).toBe(1)
  })
})
