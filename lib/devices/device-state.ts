/**
 * WHAT A PHYSICAL DEVICE IS, AND WHAT STATE IT IS IN -- derived from restaurant_terminals only.
 *
 * One row of restaurant_terminals is a payment terminal (station_kind NULL) or a kitchen/bar screen
 * (station_kind 'kitchen'|'bar'). The row carries two flags that were never meant to describe a
 * lifecycle on their own: `status` (active|inactive|revoked|pending, enforced by a CHECK) and
 * `active` (false while a code is redeemable, true once a device has used it). The dashboard's old
 * Deactivate wrote status='inactive' and left active=true, so neither flag alone says what an admin
 * needs to know. This module is the one place the combination is read.
 *
 * EVERY THRESHOLD COMES FROM THE SYSTEM, NOT FROM TASTE:
 *   - ONLINE: the device has sent a heartbeat within two of its own heartbeat intervals plus a
 *     minute of slack. The P5 app beats every 5 minutes (useTerminalHeartbeat, #373); the kitchen
 *     and bar screens every 60 seconds (app/kitchen, app/bar). One missed beat is not "offline".
 *   - STALE: the device can no longer reconnect by itself -- its refresh session is gone or past
 *     refresh_token_expires_at (30 days from its last refresh). Only reactivation brings it back.
 *     That is a fact about the row, not an age picked for the screen.
 */

export type DeviceKind = 'payment' | 'kitchen' | 'bar'

export type DeviceLifecycle =
  | 'online'
  | 'offline'
  | 'stale'
  | 'never_activated'
  | 'pending'
  | 'transfer_requested'
  | 'code_expired'
  | 'deactivated'
  | 'revoked'

export type DeviceRow = {
  id: string
  restaurant_id?: string | null
  station_kind?: string | null
  status?: string | null
  active?: boolean | null
  terminal_name?: string | null
  name?: string | null
  model?: string | null
  sn?: string | null
  device_id?: string | null
  device_serial?: string | null
  app_version?: string | null
  created_at?: string | null
  activated_at?: string | null
  last_seen_at?: string | null
  activation_code?: string | null
  activation_code_expires_at?: string | null
  refresh_token_hash?: string | null
  refresh_token_expires_at?: string | null
  transfer_request_device_id?: string | null
  transfer_requested_at?: string | null
  transfer_approved_at?: string | null
}

/** Heartbeat cadence per kind, in ms (see the header for where each figure comes from). */
export const HEARTBEAT_INTERVAL_MS: Record<DeviceKind, number> = {
  payment: 5 * 60_000,
  kitchen: 60_000,
  bar: 60_000,
}

/** Two intervals plus a minute: one missed heartbeat is not "offline". */
export function onlineWindowMs(kind: DeviceKind): number {
  return 2 * HEARTBEAT_INTERVAL_MS[kind] + 60_000
}

export function deviceKind(row: Pick<DeviceRow, 'station_kind'>): DeviceKind {
  return row.station_kind === 'kitchen' ? 'kitchen' : row.station_kind === 'bar' ? 'bar' : 'payment'
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/** A code row: a pending row nobody has activated yet, whether or not its code still works. */
export function isCodeRow(row: DeviceRow): boolean {
  return row.status === 'pending' && !row.activated_at && Boolean(row.activation_code)
}

export function deviceLifecycle(row: DeviceRow, now: number = Date.now()): DeviceLifecycle {
  if (row.status === 'revoked') return 'revoked'
  if (row.status === 'inactive') return 'deactivated'

  if (row.status === 'pending') {
    if (row.activation_code) {
      const expires = ms(row.activation_code_expires_at)
      if (expires !== null && expires <= now) return 'code_expired'
      if (row.transfer_request_device_id && row.transfer_requested_at) return 'transfer_requested'
      return 'pending'
    }
    return 'never_activated'
  }

  // status 'active' (or anything unrecognised, read as active so it is never hidden).
  if (!row.activated_at && !row.device_id) return 'never_activated'

  const refreshExpires = ms(row.refresh_token_expires_at)
  const sessionUsable = Boolean(row.refresh_token_hash) && refreshExpires !== null && refreshExpires > now
  if (!sessionUsable) return 'stale'

  const lastSeen = ms(row.last_seen_at)
  if (lastSeen !== null && now - lastSeen <= onlineWindowMs(deviceKind(row))) return 'online'
  return 'offline'
}

/** Labels staff read. Never an enum name, a constraint or a code. */
export const LIFECYCLE_LABEL: Record<DeviceLifecycle, string> = {
  online: 'Online',
  offline: 'Offline',
  stale: 'Needs reactivation',
  never_activated: 'Never activated',
  pending: 'Waiting for activation',
  transfer_requested: 'Transfer requested',
  code_expired: 'Code expired',
  deactivated: 'Deactivated',
  revoked: 'Disconnected',
}

export const LIFECYCLE_EXPLANATION: Record<DeviceLifecycle, string> = {
  online: 'Connected and checking in normally.',
  offline: 'Registered and signed in, but it has not checked in recently. Check that it is on and connected.',
  stale: 'This device has been signed out for too long to reconnect by itself. Activate it again with a new code.',
  never_activated: 'This device has not been activated yet.',
  pending: 'An activation code has been issued. Enter it on the device to finish setting it up.',
  transfer_requested:
    'A device that is registered to another restaurant tried to use this code. Approve the transfer to move it here.',
  code_expired: 'This activation code has expired. Issue a new one.',
  deactivated: 'This device is switched off for your restaurant. It keeps its registration and can be reactivated.',
  revoked: 'This device was disconnected. It cannot sign in until it is paired again.',
}

export type DeviceTone = 'good' | 'warn' | 'bad' | 'muted' | 'info'

export const LIFECYCLE_TONE: Record<DeviceLifecycle, DeviceTone> = {
  online: 'good',
  offline: 'warn',
  stale: 'bad',
  never_activated: 'muted',
  pending: 'info',
  transfer_requested: 'info',
  code_expired: 'muted',
  deactivated: 'muted',
  revoked: 'muted',
}

const GENERIC_NAMES = new Set(['', 'new terminal', 'terminal'])

/**
 * The identifier a person can match against the physical device: the WisePOS serial printed on the
 * back when the device reported one, otherwise the tail of its device id. Never the row UUID.
 */
export function physicalIdentifier(row: DeviceRow): string | null {
  if (row.sn && !row.sn.startsWith('ft-')) return row.sn
  const id = row.device_id || (row.device_serial && !row.device_serial.startsWith('ft-') ? row.device_serial : null)
  return id ? id : null
}

export function shortDeviceId(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > 8 ? `…${value.slice(-6)}` : value
}

export function deviceModel(row: DeviceRow): string {
  if (row.model && row.model.trim()) return row.model.trim()
  const kind = deviceKind(row)
  if (kind !== 'payment') return kind === 'kitchen' ? 'Kitchen screen' : 'Bar screen'
  if (row.sn && /^WP/i.test(row.sn)) return 'Wiseasy terminal'
  return 'Payment terminal'
}

/** "New Terminal" is not a name. Fall back to something that tells two devices apart. */
export function deviceDisplayName(row: DeviceRow): string {
  const raw = String(row.terminal_name || row.name || '').trim()
  if (!GENERIC_NAMES.has(raw.toLowerCase())) return raw
  const kind = deviceKind(row)
  const base = kind === 'payment' ? 'Payment terminal' : kind === 'kitchen' ? 'Kitchen screen' : 'Bar screen'
  const ident = row.sn && !row.sn.startsWith('ft-') ? row.sn : shortDeviceId(row.device_id)
  return ident ? `${base} ${ident}` : base
}

/** "5 minutes ago", "yesterday", "Never connected" -- the primary way a time is shown. */
export function relativeTime(value: string | null | undefined, now: number = Date.now()): string {
  const t = ms(value)
  if (t === null) return 'Never connected'
  const diff = Math.max(0, now - t)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : 'Over a year ago'
}

// ------------------------------------------------------------------------------------------------
// Search, filter, sort -- pure, so the console and its tests share one definition.
// ------------------------------------------------------------------------------------------------

export type DeviceFilter = {
  query?: string
  kind?: DeviceKind | 'all'
  lifecycle?: DeviceLifecycle | 'all'
  connection?: 'all' | 'online' | 'offline'
  activation?: 'all' | 'activated' | 'never_activated'
  model?: string | 'all'
}

/**
 * The lifecycle to filter and sort by. A row the SERVER already classified carries `lifecycle`; the
 * browser never holds the refresh-session fields `stale` is derived from, so it must not recompute.
 */
export function lifecycleOf(row: DeviceRow & { lifecycle?: DeviceLifecycle }, now: number = Date.now()): DeviceLifecycle {
  return row.lifecycle ?? deviceLifecycle(row, now)
}

export function matchesDevice(row: DeviceRow & { lifecycle?: DeviceLifecycle }, filter: DeviceFilter, now: number = Date.now()): boolean {
  const lifecycle = lifecycleOf(row, now)
  if (filter.kind && filter.kind !== 'all' && deviceKind(row) !== filter.kind) return false
  if (filter.lifecycle && filter.lifecycle !== 'all' && lifecycle !== filter.lifecycle) return false
  if (filter.connection === 'online' && lifecycle !== 'online') return false
  if (filter.connection === 'offline' && !['offline', 'stale'].includes(lifecycle)) return false
  if (filter.activation === 'activated' && !row.activated_at) return false
  if (filter.activation === 'never_activated' && row.activated_at) return false
  if (filter.model && filter.model !== 'all' && deviceModel(row) !== filter.model) return false
  const q = (filter.query ?? '').trim().toLowerCase()
  if (q) {
    const hay = [deviceDisplayName(row), row.terminal_name, row.name, row.sn, row.device_id, deviceModel(row)]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase())
    if (!hay.some((v) => v.includes(q))) return false
  }
  return true
}

export type DeviceSort = 'name' | 'last_seen' | 'activated' | 'status'

const STATUS_ORDER: DeviceLifecycle[] = [
  'transfer_requested',
  'online',
  'offline',
  'stale',
  'pending',
  'never_activated',
  'code_expired',
  'deactivated',
  'revoked',
]

export function sortDevices<T extends DeviceRow & { lifecycle?: DeviceLifecycle }>(rows: T[], sort: DeviceSort, now: number = Date.now()): T[] {
  const out = [...rows]
  const byTimeDesc = (a: string | null | undefined, b: string | null | undefined) => (ms(b) ?? -Infinity) - (ms(a) ?? -Infinity)
  out.sort((a, b) => {
    switch (sort) {
      case 'name':
        return deviceDisplayName(a).localeCompare(deviceDisplayName(b))
      case 'last_seen':
        return byTimeDesc(a.last_seen_at, b.last_seen_at)
      case 'activated':
        return byTimeDesc(a.activated_at, b.activated_at)
      case 'status':
        return STATUS_ORDER.indexOf(lifecycleOf(a, now)) - STATUS_ORDER.indexOf(lifecycleOf(b, now))
    }
  })
  return out
}

/** What an admin may do to a device in a given state. The routes enforce the same table. */
export type DeviceAction = 'rename' | 'deactivate' | 'reactivate' | 'revoke' | 'remove' | 'cancel_code' | 'approve_transfer'

export function allowedActions(row: DeviceRow, now: number = Date.now()): DeviceAction[] {
  const lifecycle = deviceLifecycle(row, now)
  const kind = deviceKind(row)
  if (lifecycle === 'pending' || lifecycle === 'code_expired') return ['rename', 'cancel_code']
  if (lifecycle === 'transfer_requested') return ['approve_transfer', 'cancel_code']
  const actions: DeviceAction[] = ['rename']
  if (lifecycle === 'deactivated') actions.push('reactivate')
  else if (lifecycle !== 'revoked' && lifecycle !== 'never_activated') actions.push('deactivate')
  if (kind !== 'payment' && lifecycle !== 'revoked') actions.push('revoke')
  actions.push('remove')
  return actions
}
