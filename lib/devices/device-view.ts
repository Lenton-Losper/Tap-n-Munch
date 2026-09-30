/**
 * The ONE shape the Devices console receives. Built on the server so nothing the browser should not
 * hold -- a full activation code, a refresh-token hash -- ever leaves it.
 */
import {
  allowedActions,
  deviceDisplayName,
  deviceKind,
  deviceLifecycle,
  deviceModel,
  physicalIdentifier,
  type DeviceAction,
  type DeviceKind,
  type DeviceLifecycle,
  type DeviceRow,
} from '@/lib/devices/device-state'

export type DeviceView = {
  id: string
  kind: DeviceKind
  name: string
  /** What an admin typed, or null when the row still carries a generic name. */
  customName: string | null
  model: string
  /** WisePOS serial when known, else the device id. Null before a device has activated. */
  identifier: string | null
  serial: string | null
  deviceId: string | null
  appVersion: string | null
  lifecycle: DeviceLifecycle
  lastSeenAt: string | null
  activatedAt: string | null
  createdAt: string | null
  lastSaleAt: string | null
  /** Last four characters of a live or expired activation code; never the whole code. */
  codeHint: string | null
  codeExpiresAt: string | null
  transferRequestedAt: string | null
  transferApproved: boolean
  actions: DeviceAction[]
  // Raw fields the pure helpers (search, sort, lifecycle) read on the client.
  status: string | null
  station_kind: string | null
  terminal_name: string | null
  sn: string | null
  device_id: string | null
  last_seen_at: string | null
  activated_at: string | null
}

export function toDeviceView(row: DeviceRow, now: number, lastSaleAt: string | null): DeviceView {
  const rawName = String(row.terminal_name || row.name || '').trim()
  const generic = ['', 'new terminal', 'terminal'].includes(rawName.toLowerCase())
  const code = row.activation_code ? String(row.activation_code) : null
  return {
    id: String(row.id),
    kind: deviceKind(row),
    name: deviceDisplayName(row),
    customName: generic ? null : rawName,
    model: deviceModel(row),
    identifier: physicalIdentifier(row),
    serial: row.sn && !row.sn.startsWith('ft-') ? row.sn : null,
    deviceId: row.device_id ?? null,
    appVersion: row.app_version ?? null,
    lifecycle: deviceLifecycle(row, now),
    lastSeenAt: row.activated_at ? (row.last_seen_at ?? null) : null,
    activatedAt: row.activated_at ?? null,
    createdAt: row.created_at ?? null,
    lastSaleAt,
    codeHint: code ? code.slice(-4) : null,
    codeExpiresAt: code ? (row.activation_code_expires_at ?? null) : null,
    transferRequestedAt: row.transfer_requested_at ?? null,
    transferApproved: Boolean(row.transfer_approved_at),
    actions: allowedActions(row, now),
    status: row.status ?? null,
    station_kind: row.station_kind ?? null,
    terminal_name: row.terminal_name ?? null,
    sn: row.sn ?? null,
    device_id: row.device_id ?? null,
    last_seen_at: row.activated_at ? (row.last_seen_at ?? null) : null,
    activated_at: row.activated_at ?? null,
  }
}
