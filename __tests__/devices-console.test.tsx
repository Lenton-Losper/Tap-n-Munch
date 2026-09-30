/**
 * @jest-environment jsdom
 *
 * Settings -> Devices, rendered. The questions an admin must be able to answer at a glance:
 * what devices do I have, which physical P5 is this, is it online, when did it last connect, why
 * can't this device activate and how do I let it, how do I remove one. And the vocabulary rule:
 * no enum, error code or row UUID on screen.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DeviceView } from '@/lib/devices/device-view'

jest.mock('@/components/settings/settings-utils', () => ({ getSettingsAccessToken: async () => 'token' }))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))

import { DevicesConsole } from '@/components/devices/devices-console'

const ROW_UUID = '9c9bfeef-6695-4dc7-814c-060c3a67d7fc'
const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

function view(over: Partial<DeviceView>): DeviceView {
  return {
    id: ROW_UUID,
    kind: 'payment',
    name: 'Payment terminal WPHK002502002822',
    customName: null,
    model: 'Wiseasy terminal',
    identifier: 'WPHK002502002822',
    serial: 'WPHK002502002822',
    deviceId: 'b68914779e542823',
    appVersion: '2.42',
    lifecycle: 'online',
    lastSeenAt: recent(2),
    activatedAt: recent(120),
    createdAt: recent(200),
    lastSaleAt: recent(30),
    codeHint: null,
    codeExpiresAt: null,
    transferRequestedAt: null,
    transferApproved: false,
    actions: ['rename', 'deactivate', 'remove'],
    status: 'active',
    station_kind: null,
    terminal_name: 'New Terminal',
    sn: 'WPHK002502002822',
    device_id: 'b68914779e542823',
    last_seen_at: recent(2),
    activated_at: recent(120),
    ...over,
  }
}

const DEVICES: DeviceView[] = [
  view({}),
  view({
    id: 'a0000000-0000-4000-8000-00000000000b',
    name: 'Patio till',
    customName: 'Patio till',
    serial: null,
    sn: null,
    identifier: '6799d4ca39a2c328',
    deviceId: '6799d4ca39a2c328',
    device_id: '6799d4ca39a2c328',
    model: 'Payment terminal',
    lifecycle: 'offline',
    lastSeenAt: recent(90),
    last_seen_at: recent(90),
  }),
  view({
    id: 'a0000000-0000-4000-8000-00000000000c',
    kind: 'kitchen',
    station_kind: 'kitchen',
    name: 'Pass',
    customName: 'Pass',
    model: 'Kitchen screen',
    serial: null,
    sn: null,
    deviceId: null,
    device_id: null,
    identifier: null,
    appVersion: null,
    lifecycle: 'revoked',
    actions: ['rename', 'remove'],
  }),
  view({
    id: 'a0000000-0000-4000-8000-00000000000d',
    name: 'New Terminal',
    lifecycle: 'transfer_requested',
    activatedAt: null,
    activated_at: null,
    lastSeenAt: null,
    codeHint: 'EJ5Z',
    codeExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    transferRequestedAt: recent(1),
    serial: null,
    sn: null,
    deviceId: null,
    device_id: null,
    actions: ['approve_transfer', 'cancel_code'],
  }),
]

let calls: Array<{ url: string; method: string; body: unknown }> = []

function installFetch() {
  calls = []
  ;(globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    let body: unknown = { ok: true }
    if (url === '/api/admin/devices' && method === 'GET') {
      body = { devices: DEVICES, canManage: { payment: true, kitchen: true, bar: true }, restaurantName: 'FNB ChowNow' }
    } else if (url.endsWith('/activity')) {
      body = { events: [{ at: recent(5), action: 'terminal.activated', description: 'Activated on this device' }] }
    }
    return { ok: true, status: 200, json: async () => body }
  })
}

let container: HTMLDivElement
let root: Root

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<DevicesConsole />)
  })
  await flush()
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

function byTestId(id: string, scope: ParentNode = document): HTMLElement[] {
  return Array.from(scope.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  installFetch()
  await mount()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('V. what each device is, at a glance', () => {
  it('shows the physical serial, model, app version and last seen -- never the row UUID', () => {
    const card = byTestId('device-card')[0]
    const text = card.textContent ?? ''
    expect(text).toContain('Payment terminal WPHK002502002822')
    expect(text).toContain('Wiseasy terminal')
    expect(text).toContain('2.42')
    expect(text).toMatch(/2 minutes ago/)
    expect(container.textContent).not.toContain(ROW_UUID)
  })

  it('status in words, not enums', () => {
    const labels = byTestId('device-status-badge').map((b) => b.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Online', 'Offline']))
    expect(container.textContent).not.toMatch(/never_activated|transfer_requested|DEVICE_REGISTERED_ELSEWHERE|reject_cross_restaurant/)
  })

  it('a summary answers "what do I have, which are online"', () => {
    const summary = byTestId('devices-summary')[0].textContent ?? ''
    // Two P5s and the kitchen screen; the pending code is not a device yet.
    expect(summary).toMatch(/3\s*Devices/)
    expect(summary).toMatch(/1\s*Online/)
    expect(summary).toMatch(/1\s*Offline/)
    // The transfer request waiting for a decision.
    expect(summary).toMatch(/1\s*Need attention/)
  })
})

describe('U. search', () => {
  it('narrows the list by serial or device id', async () => {
    const input = container.querySelector('input[aria-label="Search devices"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '6799d4')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const names = byTestId('device-name').map((n) => n.textContent)
    expect(names).toEqual(['Patio till'])
  })
})

describe('F19 recovery: a device registered to another restaurant', () => {
  it('is announced, reviewable, and explained before anything happens', async () => {
    const banner = byTestId('transfer-request')[0]
    expect(banner.textContent).toMatch(/registered to another restaurant wants to join/i)
    expect(banner.textContent).toContain('EJ5Z')
    await click(Array.from(banner.querySelectorAll('button')).find((b) => /review/i.test(b.textContent ?? ''))!)
    const details = byTestId('device-details')[0]
    expect(details).toBeDefined()
    await click(byTestId('device-action-approve_transfer')[0])
    const confirm = byTestId('device-confirm')[0]
    expect(confirm.textContent).toMatch(/disconnects it from its current restaurant/i)
    expect(confirm.textContent).toMatch(/keeps its order and payment history/i)
    await click(byTestId('device-confirm-button')[0])
    expect(calls).toContainEqual(
      expect.objectContaining({ url: '/api/admin/devices/a0000000-0000-4000-8000-00000000000d', method: 'PATCH', body: { action: 'approve_transfer' } }),
    )
  })
})

describe('actions: safe hierarchy, and nothing without an explanation', () => {
  it('destructive actions live apart in a danger zone; Remove explains release before confirming', async () => {
    await click(byTestId('device-manage')[0])
    const danger = byTestId('device-danger-zone')[0]
    expect(danger.textContent).toMatch(/Deactivate/)
    expect(danger.textContent).toMatch(/Remove device/)
    // Nothing has been sent yet: only the list and the activity read.
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    await click(byTestId('device-action-remove')[0])
    const confirm = byTestId('device-confirm')[0].textContent ?? ''
    expect(confirm).toMatch(/permanently removes/i)
    expect(confirm).toMatch(/released/i)
    expect(confirm).toMatch(/past orders and payments are not affected/i)
    await click(byTestId('device-confirm-button')[0])
    expect(calls).toContainEqual(expect.objectContaining({ url: `/api/admin/devices/${ROW_UUID}`, method: 'DELETE' }))
  })

  it('Deactivate explains that the device keeps its registration', async () => {
    await click(byTestId('device-manage')[0])
    await click(byTestId('device-action-deactivate')[0])
    expect(byTestId('device-confirm')[0].textContent).toMatch(/stays registered here, keeps its identity/i)
  })

  it('the details show identity, connection, restaurant and activity', async () => {
    await click(byTestId('device-manage')[0])
    const details = byTestId('device-details')[0].textContent ?? ''
    expect(details).toContain('WPHK002502002822')
    expect(details).toContain('b68914779e542823')
    expect(details).toContain('FNB ChowNow')
    expect(details).toContain('Activated on this device')
  })
})

describe('T. screens: a disconnected screen has a clear way back', () => {
  it('offers Re-pair, which reissues a code for the SAME screen', async () => {
    const screensTab = Array.from(container.querySelectorAll('button')).find((b) => /Kitchen & bar screens/.test(b.textContent ?? ''))!
    await act(async () => {
      screensTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      screensTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const card = byTestId('device-card').find((c) => (c.textContent ?? '').includes('Pass'))!
    expect(card.textContent).toMatch(/Disconnected/)
    await click(card.querySelector('[data-testid="device-manage"]')!)
    expect(byTestId('device-explanation')[0].textContent).toMatch(/cannot sign in until it is paired again/i)
    await click(byTestId('device-action-repair')[0])
    expect(calls).toContainEqual(
      expect.objectContaining({ url: '/api/admin/terminals/stations/a0000000-0000-4000-8000-00000000000c/reissue-code', method: 'POST' }),
    )
  })
})
