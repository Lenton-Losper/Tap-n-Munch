/**
 * @jest-environment jsdom
 *
 * Behavioural cover for the Order History date filter: the quick-select presets populate
 * both fields and refetch, and an inverted range is refused instead of being rendered as a
 * real "0 orders" result.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// --- module mocks, declared before the component is imported ---

jest.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({
    restaurant: { id: 'r1', currency: 'N$' },
    restaurantId: 'r1',
    user: { email: 'owner@example.com' },
  }),
}))

jest.mock('@/lib/onboarding/api-client', () => ({
  getAccessToken: async () => 'test-token',
}))

// Radix's Select needs layout APIs jsdom lacks; a native control is enough here.
jest.mock('@/components/ui/select', () => {
  const React = require('react')
  return {
    Select: ({ children }: any) => React.createElement('div', null, children),
    SelectContent: ({ children }: any) => React.createElement('div', null, children),
    SelectItem: ({ children }: any) => React.createElement('div', null, children),
    SelectTrigger: ({ children }: any) => React.createElement('div', null, children),
    SelectValue: () => null,
  }
})

import { OrderHistoryContent } from '@/components/order-history/order-history-content'

const EMPTY_RESPONSE = {
  orders: [],
  total: 0,
  page: 1,
  pageSize: 20,
  totalRevenue: 0,
  totalOrders: 0,
  avgOrderValue: 0,
}

let container: HTMLDivElement
let root: Root
let fetchMock: jest.Mock

/** Every /api/orders/history URL requested so far. */
function historyCalls(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/orders/history?'))
}

function lastHistoryParams(): URLSearchParams {
  const calls = historyCalls()
  return new URLSearchParams(calls[calls.length - 1].split('?')[1])
}

function dateInput(label: 'Start date' | 'End date'): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll('label'))
  const match = labels.find((l) => l.textContent?.trim() === label)
  if (!match) throw new Error(`no field labelled "${label}"`)
  const input = match.parentElement?.querySelector('input')
  if (!input) throw new Error(`no input under "${label}"`)
  return input as HTMLInputElement
}

function presetButton(text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'))
  const match = buttons.find((b) => b.textContent?.trim() === text)
  if (!match) throw new Error(`no button labelled "${text}"`)
  return match as HTMLButtonElement
}

/** Drive a controlled React input the way the browser does. */
async function setDate(label: 'Start date' | 'End date', value: string) {
  const input = dateInput(label)
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
  // A Thursday, 15:29 Windhoek -- the same instant as the order-#81 report.
  jest.setSystemTime(new Date('2026-07-30T13:29:23.000Z'))

  fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => EMPTY_RESPONSE,
    blob: async () => new Blob(['x']),
  }))
  ;(globalThis as any).fetch = fetchMock

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<OrderHistoryContent />)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('default range', () => {
  it('defaults both fields to the restaurant-local today', () => {
    expect(dateInput('Start date').value).toBe('2026-07-30')
    expect(dateInput('End date').value).toBe('2026-07-30')
  })

  it('queries that range on mount', () => {
    const params = lastHistoryParams()
    expect(params.get('startDate')).toBe('2026-07-30')
    expect(params.get('endDate')).toBe('2026-07-30')
  })
})

describe('quick-select presets', () => {
  const cases: Array<[string, string, string]> = [
    ['Today', '2026-07-30', '2026-07-30'],
    ['Yesterday', '2026-07-29', '2026-07-29'],
    ['Last 2 Days', '2026-07-29', '2026-07-30'],
    ['This Week', '2026-07-27', '2026-07-30'],
    ['This Month', '2026-07-01', '2026-07-30'],
    ['This Year', '2026-01-01', '2026-07-30'],
  ]

  it.each(cases)('%s populates both fields and refreshes the results', async (label, start, end) => {
    const before = historyCalls().length
    await click(presetButton(label))

    // 1. both date fields updated
    expect(dateInput('Start date').value).toBe(start)
    expect(dateInput('End date').value).toBe(end)

    // 2. the results actually refreshed -- including for Today, which already matches the
    //    mount default; a preset click that appears to do nothing reads as a broken button.
    expect(historyCalls().length).toBeGreaterThan(before)
    const params = lastHistoryParams()
    expect(params.get('startDate')).toBe(start)
    expect(params.get('endDate')).toBe(end)
  })

  it('marks the active preset and moves the marker when another is chosen', async () => {
    await click(presetButton('This Month'))
    expect(presetButton('This Month').getAttribute('aria-pressed')).toBe('true')
    expect(presetButton('Yesterday').getAttribute('aria-pressed')).toBe('false')

    await click(presetButton('Yesterday'))
    expect(presetButton('Yesterday').getAttribute('aria-pressed')).toBe('true')
    expect(presetButton('This Month').getAttribute('aria-pressed')).toBe('false')
  })

  it('resets to page 1 so a preset cannot land on an out-of-range page', async () => {
    await click(presetButton('This Year'))
    expect(lastHistoryParams().get('page')).toBe('1')
  })
})

describe('end date before start date', () => {
  it('does not send the query that would return a misleading empty result', async () => {
    const before = historyCalls().length
    await setDate('End date', '2026-07-01') // start is still 2026-07-30
    expect(historyCalls().length).toBe(before)
  })

  it('explains the problem instead of showing "No orders found"', async () => {
    await setDate('End date', '2026-07-01')
    const text = container.textContent ?? ''
    expect(text).toMatch(/end date is before the start date/i)
    expect(text).not.toMatch(/No orders found/i)
  })

  it('does not render the zeroed revenue/order stat cards as if they were real', async () => {
    await setDate('End date', '2026-07-01')
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/Total Revenue/i)
    expect(text).not.toMatch(/Average Order Value/i)
  })

  it('offers a swap that repairs the range and re-runs the query', async () => {
    await setDate('End date', '2026-07-01')
    const before = historyCalls().length

    await click(presetButton('Swap dates'))

    expect(dateInput('Start date').value).toBe('2026-07-01')
    expect(dateInput('End date').value).toBe('2026-07-30')
    expect(historyCalls().length).toBeGreaterThan(before)
    const params = lastHistoryParams()
    expect(params.get('startDate')).toBe('2026-07-01')
    expect(params.get('endDate')).toBe('2026-07-30')
    expect(container.textContent ?? '').not.toMatch(/end date is before the start date/i)
  })

  it('constrains the native pickers so the invalid combination is hard to reach', () => {
    expect(dateInput('End date').getAttribute('min')).toBe('2026-07-30')
    expect(dateInput('Start date').getAttribute('max')).toBe('2026-07-30')
  })

  it('blocks Download and Send by Email so no silently empty report leaves the app', async () => {
    await setDate('End date', '2026-07-01')
    const buttons = Array.from(container.querySelectorAll('button'))
    const download = buttons.find((b) => b.textContent?.trim() === 'Download')
    const email = buttons.find((b) => b.textContent?.trim() === 'Send by Email')
    expect(download?.hasAttribute('disabled')).toBe(true)
    expect(email?.hasAttribute('disabled')).toBe(true)
  })

  it('recovers when the range is made valid again', async () => {
    await setDate('End date', '2026-07-01')
    await setDate('End date', '2026-07-31')
    expect(container.textContent ?? '').not.toMatch(/end date is before the start date/i)
    expect(lastHistoryParams().get('endDate')).toBe('2026-07-31')
  })
})

describe('a cleared date field', () => {
  it('asks for both dates rather than silently querying today', async () => {
    const before = historyCalls().length
    await setDate('Start date', '')
    expect(historyCalls().length).toBe(before)
    expect(container.textContent ?? '').toMatch(/both a start date and an end date/i)
  })
})
