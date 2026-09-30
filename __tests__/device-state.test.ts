/**
 * lib/devices/device-state -- what a device IS and what state it is in, from its row alone.
 * Every threshold is a fact of the system (heartbeat cadence, refresh-session lifetime), so these
 * tests state the fact next to the expectation.
 */
import {
  allowedActions,
  deviceDisplayName,
  deviceLifecycle,
  deviceModel,
  matchesDevice,
  onlineWindowMs,
  physicalIdentifier,
  relativeTime,
  sortDevices,
  type DeviceRow,
} from '@/lib/devices/device-state'

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const FUTURE = '2026-10-30T00:00:00.000Z'

const p5 = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'p5',
  status: 'active',
  active: true,
  station_kind: null,
  terminal_name: 'New Terminal',
  sn: 'WPHK002502002822',
  device_id: 'b68914779e542823',
  activated_at: ago(60 * MIN),
  last_seen_at: ago(2 * MIN),
  refresh_token_hash: 'h',
  refresh_token_expires_at: FUTURE,
  ...over,
})

describe('V. lifecycle states', () => {
  it('online: a P5 seen within two heartbeats (5 min each) plus a minute', () => {
    expect(onlineWindowMs('payment')).toBe(11 * MIN)
    expect(deviceLifecycle(p5({ last_seen_at: ago(10 * MIN) }), NOW)).toBe('online')
  })

  it('offline: a P5 not seen for longer than that, with a usable session', () => {
    expect(deviceLifecycle(p5({ last_seen_at: ago(12 * MIN) }), NOW)).toBe('offline')
  })

  it('screens beat every 60 s, so their window is 3 minutes', () => {
    const screen = p5({ station_kind: 'kitchen', last_seen_at: ago(4 * MIN) })
    expect(onlineWindowMs('kitchen')).toBe(3 * MIN)
    expect(deviceLifecycle(screen, NOW)).toBe('offline')
    expect(deviceLifecycle({ ...screen, last_seen_at: ago(2 * MIN) }, NOW)).toBe('online')
  })

  it('stale: the refresh session is gone or expired -- it cannot reconnect by itself', () => {
    expect(deviceLifecycle(p5({ refresh_token_hash: null }), NOW)).toBe('stale')
    expect(deviceLifecycle(p5({ refresh_token_expires_at: ago(1) }), NOW)).toBe('stale')
  })

  it('deactivated / revoked come from status, whatever `active` says', () => {
    // The old dashboard wrote status 'inactive' and left active=true: still deactivated.
    expect(deviceLifecycle(p5({ status: 'inactive', active: true }), NOW)).toBe('deactivated')
    expect(deviceLifecycle(p5({ status: 'revoked', active: false }), NOW)).toBe('revoked')
  })

  it('pending / code expired / transfer requested for an unused code row', () => {
    const code = { id: 'c', status: 'pending', active: false, activation_code: 'FT-AAAA-BBBB', activated_at: null }
    expect(deviceLifecycle({ ...code, activation_code_expires_at: FUTURE }, NOW)).toBe('pending')
    expect(deviceLifecycle({ ...code, activation_code_expires_at: ago(1) }, NOW)).toBe('code_expired')
    expect(
      deviceLifecycle(
        { ...code, activation_code_expires_at: FUTURE, transfer_request_device_id: 'd', transfer_requested_at: ago(MIN) },
        NOW,
      ),
    ).toBe('transfer_requested')
  })

  it('never activated: a registered row no device ever used (bulk-added)', () => {
    expect(deviceLifecycle(p5({ activated_at: null, device_id: null }), NOW)).toBe('never_activated')
    expect(deviceLifecycle({ id: 'x', status: 'pending', activation_code: null }, NOW)).toBe('never_activated')
  })
})

describe('what a person recognises a device by', () => {
  it('"New Terminal" is not a name: fall back to the serial printed on the device', () => {
    expect(deviceDisplayName(p5())).toBe('Payment terminal WPHK002502002822')
    expect(deviceDisplayName(p5({ terminal_name: 'Kitchen P5' }))).toBe('Kitchen P5')
  })

  it('without a serial, the tail of the device id -- never the row UUID', () => {
    const noSerial = p5({ sn: null, id: '9c9bfeef-6695-4dc7-814c-060c3a67d7fc' })
    expect(deviceDisplayName(noSerial)).toBe('Payment terminal …542823')
    expect(deviceDisplayName(noSerial)).not.toContain('9c9bfeef')
  })

  it('physical identifier prefers the serial, ignores ft- placeholders', () => {
    expect(physicalIdentifier(p5())).toBe('WPHK002502002822')
    expect(physicalIdentifier(p5({ sn: null }))).toBe('b68914779e542823')
    expect(physicalIdentifier(p5({ sn: null, device_id: null, device_serial: 'ft-abc' }))).toBeNull()
  })

  it('model: the recorded one, else what the serial proves, else the kind', () => {
    expect(deviceModel(p5({ model: 'P5 Lite' }))).toBe('P5 Lite')
    expect(deviceModel(p5())).toBe('Wiseasy terminal')
    expect(deviceModel(p5({ sn: null }))).toBe('Payment terminal')
    expect(deviceModel(p5({ station_kind: 'bar' }))).toBe('Bar screen')
  })

  it('relative time is the primary way a time is shown', () => {
    expect(relativeTime(null, NOW)).toBe('Never connected')
    expect(relativeTime(ago(20_000), NOW)).toBe('Just now')
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5 minutes ago')
    expect(relativeTime(ago(1 * MIN), NOW)).toBe('1 minute ago')
    expect(relativeTime(ago(3 * 60 * MIN), NOW)).toBe('3 hours ago')
    expect(relativeTime(ago(30 * 60 * MIN), NOW)).toBe('Yesterday')
    expect(relativeTime(ago(5 * 24 * 60 * MIN), NOW)).toBe('5 days ago')
  })
})

describe('U. search, filter, sort', () => {
  const rows: Array<DeviceRow & { lifecycle?: never }> = [
    p5({ id: 'a', terminal_name: 'Front till', last_seen_at: ago(2 * MIN), activated_at: ago(3 * 24 * 60 * MIN) }),
    p5({ id: 'b', terminal_name: 'Patio', sn: 'WPYB002452000261', device_id: 'aa8168fab9b87b2d', last_seen_at: ago(60 * MIN), activated_at: ago(24 * 60 * MIN) }),
    p5({ id: 'c', terminal_name: 'Pass', station_kind: 'kitchen', sn: null, device_id: null, last_seen_at: ago(MIN) }),
    p5({ id: 'd', terminal_name: 'Old', status: 'inactive' }),
  ]

  it('search: by name, serial, device id and model', () => {
    const q = (query: string) => rows.filter((r) => matchesDevice(r, { query }, NOW)).map((r) => r.id)
    expect(q('patio')).toEqual(['b'])
    expect(q('WPYB')).toEqual(['b'])
    expect(q('aa8168')).toEqual(['b'])
    expect(q('kitchen')).toEqual(['c'])
  })

  it('filter: kind, status, online/offline, model', () => {
    const f = (filter: Parameters<typeof matchesDevice>[1]) => rows.filter((r) => matchesDevice(r, filter, NOW)).map((r) => r.id)
    expect(f({ kind: 'kitchen' })).toEqual(['c'])
    expect(f({ lifecycle: 'deactivated' })).toEqual(['d'])
    expect(f({ connection: 'online' })).toEqual(['a', 'c'])
    expect(f({ connection: 'offline' })).toEqual(['b'])
    expect(f({ model: 'Kitchen screen' })).toEqual(['c'])
  })

  it('a server-classified lifecycle wins: the browser never holds the session fields', () => {
    const fromServer = { id: 'e', terminal_name: 'X', lifecycle: 'online' as const }
    expect(matchesDevice(fromServer, { connection: 'online' }, NOW)).toBe(true)
  })

  it('sort: name, last seen, activated date, status', () => {
    expect(sortDevices(rows, 'name', NOW).map((r) => r.id)).toEqual(['a', 'd', 'c', 'b'])
    expect(sortDevices(rows, 'last_seen', NOW).map((r) => r.id)[0]).toBe('c')
    // c and d were activated an hour ago (the fixture default), a three days ago, b one day ago.
    expect(sortDevices(rows, 'activated', NOW).map((r) => r.id).slice(-2)).toEqual(['b', 'a'])
    expect(sortDevices(rows, 'status', NOW).map((r) => r.id).slice(-1)).toEqual(['d'])
  })
})

describe('allowed actions follow the state', () => {
  it('an online payment terminal: rename, deactivate, remove -- never revoke', () => {
    expect(allowedActions(p5(), NOW)).toEqual(['rename', 'deactivate', 'remove'])
  })
  it('a deactivated one can be reactivated', () => {
    expect(allowedActions(p5({ status: 'inactive' }), NOW)).toEqual(['rename', 'reactivate', 'remove'])
  })
  it('a revoked device: rename or remove only -- never deactivate, never revoke again', () => {
    expect(allowedActions(p5({ status: 'revoked', station_kind: 'kitchen' }), NOW)).toEqual(['rename', 'remove'])
    expect(allowedActions(p5({ status: 'revoked' }), NOW)).toEqual(['rename', 'remove'])
  })
  it('a screen can also be disconnected (revoked)', () => {
    expect(allowedActions(p5({ station_kind: 'bar' }), NOW)).toContain('revoke')
  })
  it('a pending code: rename or cancel; a transfer request: approve or cancel', () => {
    const code = { id: 'c', status: 'pending', activation_code: 'FT-1', activation_code_expires_at: FUTURE }
    expect(allowedActions(code, NOW)).toEqual(['rename', 'cancel_code'])
    expect(allowedActions({ ...code, transfer_request_device_id: 'd', transfer_requested_at: ago(1) }, NOW)).toEqual([
      'approve_transfer',
      'cancel_code',
    ])
  })
})
