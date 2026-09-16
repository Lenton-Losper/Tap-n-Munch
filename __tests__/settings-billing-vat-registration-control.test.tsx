/**
 * @jest-environment jsdom
 *
 * D3 -- Settings -> Billing had no VAT-registration control at all.
 *
 * ================================================================================================
 * WHAT WAS MISSING, AND WHY IT MATTERED MORE THAN A MISSING FIELD USUALLY DOES
 * ================================================================================================
 *
 * `restaurant_billing_profiles.vat_registered` exists, the route reads and writes it, the database
 * has a CHECK tying it to `vat_number`, and the invoice engine reads it. The one thing nothing did
 * was ASK. No surface in the product let a merchant state whether they are VAT registered, so the
 * column was null everywhere and the answer could only be set by hand.
 *
 * It also made D1 invisible. A form that never sends `vat_registered` cannot notice that saving it
 * wipes the value -- which is exactly how a destructive save survived in a shipped route.
 *
 * ================================================================================================
 * WHAT THESE TESTS HOLD
 * ================================================================================================
 *
 * The three states the column has are all reachable; the answer loads from the server and is sent
 * back on save; the VAT-number rule is applied consistently with the route's; and where the venue's
 * database cannot hold the answer, no control is offered and no key is sent.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({ restaurantId: 'rest-1' }),
}))

jest.mock('@/components/settings/settings-utils', () => ({
  getSettingsAccessToken: async () => 'test-token',
}))

jest.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ hasPermission: () => true, permissionsLoaded: true }),
}))

const toasts: Array<{ title?: string; description?: string; variant?: string }> = []
/**
 * THE toast FUNCTION MUST BE STABLE ACROSS RENDERS, and that is not a detail of the mock.
 *
 * `loadBillingProfile` is a useCallback with `toast` in its deps, and the effect that calls it has
 * `loadBillingProfile` in its. A mock that hands back a fresh closure on every render therefore
 * gives the effect a new identity on every render, so it re-fetches, re-renders, and re-fetches --
 * a render loop that jest reports as a 15-second test timeout with no assertion text and no clue
 * as to the cause. The real useToast returns a stable function; so does this.
 */
const recordToast = (t: { title?: string }) => {
  toasts.push(t)
}
const toastApi = { toast: recordToast }
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => toastApi,
}))

import { SettingsBillingTab } from '@/components/settings/settings-billing-tab'

const PROFILE = {
  registration_number: 'CC/2026/0001',
  vat_number: 'VAT-778899',
  bank_name: 'Bank Windhoek',
  bank_account_name: 'Riviera Trading CC',
  bank_account_number: '8001 2233 44',
  bank_branch_code: '481972',
}

type PatchCall = { body: Record<string, unknown> }
let patches: PatchCall[]
let container: HTMLDivElement
let root: Root

function mockFetch(getPayload: Record<string, unknown>) {
  return jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push({ body })
      return {
        ok: true,
        json: async () => ({
          success: true,
          // The server echoes the row it WROTE. Reflecting the request back would make this test
          // agree with the client about a value neither of them had checked.
          billingProfile: { ...PROFILE, ...body },
          vatRegistrationSupported: getPayload.vatRegistrationSupported,
        }),
      }
    }
    return { ok: true, json: async () => getPayload }
  })
}

async function mount(getPayload: Record<string, unknown>) {
  ;(globalThis as unknown as { fetch: unknown }).fetch = mockFetch(getPayload)
  await act(async () => {
    root.render(<SettingsBillingTab />)
  })
}

function byId<T extends HTMLElement>(id: string): T | null {
  return container.querySelector<T>(`#${id}`)
}

async function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function save() {
  const button = Array.from(container.querySelectorAll('button')).find((b) =>
    /save billing details/i.test(b.textContent ?? ''),
  )
  await click(button ?? null)
}

beforeEach(() => {
  // Without this every act() warns and the render never settles, which reads as a timeout rather
  // than as a missing flag. Every other .tsx suite in this directory sets it the same way.
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  patches = []
  toasts.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const SUPPORTED = (vat_registered: boolean | null) => ({
  billingProfile: { ...PROFILE, vat_registered },
  vatRegistrationSupported: true,
})

describe('the VAT registration control', () => {
  test('offers all three states the column has', async () => {
    await mount(SUPPORTED(null))

    expect(byId('billing-vat-registered-yes')).not.toBeNull()
    expect(byId('billing-vat-registered-no')).not.toBeNull()
    // "Not answered" is a real state, not a placeholder: every venue is in it today.
    expect(byId('billing-vat-registered-unanswered')).not.toBeNull()
    expect(container.textContent).toContain('VAT registration')
  })

  test('shows the stored answer rather than a default', async () => {
    await mount(SUPPORTED(true))
    expect(byId('billing-vat-registered-yes')?.getAttribute('aria-checked')).toBe('true')
    expect(byId('billing-vat-registered-no')?.getAttribute('aria-checked')).toBe('false')

    await act(async () => root.unmount())
    root = createRoot(container)

    await mount(SUPPORTED(false))
    expect(byId('billing-vat-registered-no')?.getAttribute('aria-checked')).toBe('true')
    expect(byId('billing-vat-registered-yes')?.getAttribute('aria-checked')).toBe('false')
  })

  test('sends the answer on save — and does not omit it when it is unchanged', async () => {
    await mount(SUPPORTED(true))
    await save()

    expect(patches).toHaveLength(1)
    /**
     * THE CLIENT HALF OF D1. The form used to send six text fields and nothing else, which the
     * route then read as "set vat_registered to null". The route no longer destroys an omitted
     * field, but this form owns the answer it is displaying, so it states it.
     */
    expect(patches[0].body.vat_registered).toBe(true)
    expect(patches[0].body).toMatchObject(PROFILE)
  })

  test('answering "no" is saved as false, not as an absence', async () => {
    await mount(SUPPORTED(null))
    await click(byId('billing-vat-registered-no'))
    await save()

    expect(patches).toHaveLength(1)
    expect(patches[0].body.vat_registered).toBe(false)
  })

  test('answering "yes" with no VAT number is refused before the request is made', async () => {
    await mount({
      billingProfile: { ...PROFILE, vat_number: null, vat_registered: null },
      vatRegistrationSupported: true,
    })
    await click(byId('billing-vat-registered-yes'))
    await save()

    // The same rule the route and the database CHECK enforce, said in the merchant's terms.
    expect(patches).toHaveLength(0)
    expect(toasts.at(-1)?.title).toMatch(/VAT number required/i)
    expect(container.textContent).toContain('must state its VAT number')
  })

  test('answering "yes" with a VAT number present goes through', async () => {
    await mount(SUPPORTED(null))
    await click(byId('billing-vat-registered-yes'))
    await save()

    expect(patches).toHaveLength(1)
    expect(patches[0].body.vat_registered).toBe(true)
    expect(patches[0].body.vat_number).toBe(PROFILE.vat_number)
  })

  test('the saved answer is the one the server reports, and survives a remount', async () => {
    await mount(SUPPORTED(null))
    await click(byId('billing-vat-registered-yes'))
    await save()
    expect(byId('billing-vat-registered-yes')?.getAttribute('aria-checked')).toBe('true')

    // Reload: a fresh mount reading what the database now holds.
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount(SUPPORTED(true))
    expect(byId('billing-vat-registered-yes')?.getAttribute('aria-checked')).toBe('true')
  })
})

describe('a venue whose database cannot hold the answer', () => {
  const UNSUPPORTED = {
    billingProfile: { ...PROFILE, vat_registered: null },
    vatRegistrationSupported: false,
  }

  test('is offered no control, rather than one whose save is guaranteed to be refused', async () => {
    await mount(UNSUPPORTED)
    expect(byId('billing-vat-registered-yes')).toBeNull()
    expect(byId('billing-vat-registered-no')).toBeNull()
  })

  test('saves the six text fields and sends no vat_registered key at all', async () => {
    await mount(UNSUPPORTED)
    await save()

    expect(patches).toHaveLength(1)
    expect(patches[0].body).toMatchObject(PROFILE)
    // Not `null` -- ABSENT. A null would be a no-op today, but the key not being there is what
    // makes the route's VAT_REGISTRATION_UNAVAILABLE refusal unreachable from this form.
    expect('vat_registered' in patches[0].body).toBe(false)
  })
})
