'use client'

/**
 * One physical device, the way an admin needs to see it at a glance: what it is called, what it
 * physically is, whether it is connected, and when it last checked in. The row UUID is never shown.
 */
import { CreditCard, ChefHat, GlassWater, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  LIFECYCLE_EXPLANATION,
  LIFECYCLE_LABEL,
  LIFECYCLE_TONE,
  relativeTime,
  type DeviceKind,
  type DeviceLifecycle,
  type DeviceTone,
} from '@/lib/devices/device-state'
import type { DeviceView } from '@/lib/devices/device-view'

const TONE_CLASS: Record<DeviceTone, { dot: string; badge: string }> = {
  good: { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  warn: { dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  bad: { dot: 'bg-red-500', badge: 'bg-red-50 text-red-700 ring-red-600/20' },
  info: { dot: 'bg-sky-500', badge: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
  muted: { dot: 'bg-zinc-400', badge: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20' },
}

export function DeviceStatusBadge({ lifecycle }: { lifecycle: DeviceLifecycle }) {
  const tone = TONE_CLASS[LIFECYCLE_TONE[lifecycle]]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone.badge}`}
      title={LIFECYCLE_EXPLANATION[lifecycle]}
      data-testid="device-status-badge"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
      {LIFECYCLE_LABEL[lifecycle]}
    </span>
  )
}

export function DeviceKindIcon({ kind, className = 'h-5 w-5' }: { kind: DeviceKind; className?: string }) {
  if (kind === 'kitchen') return <ChefHat className={className} aria-hidden />
  if (kind === 'bar') return <GlassWater className={className} aria-hidden />
  return <CreditCard className={className} aria-hidden />
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`truncate text-right ${mono ? 'font-mono text-xs' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  )
}

export function DeviceCard({ device, onManage }: { device: DeviceView; onManage: (device: DeviceView) => void }) {
  const activated = Boolean(device.activatedAt)
  return (
    <article
      className="flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
      data-testid="device-card"
      aria-label={device.name}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <DeviceKindIcon kind={device.kind} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-semibold leading-tight" data-testid="device-name">
              {device.name}
            </h3>
            <p className="truncate text-sm text-muted-foreground">{device.model}</p>
          </div>
        </div>
        <DeviceStatusBadge lifecycle={device.lifecycle} />
      </header>

      <dl className="mt-4 space-y-1.5">
        {device.serial ? <Fact label="Serial" value={device.serial} mono /> : null}
        {!device.serial && device.deviceId ? <Fact label="Device ID" value={device.deviceId} mono /> : null}
        {device.appVersion ? <Fact label="App" value={device.appVersion} /> : null}
        {activated ? (
          <Fact label="Last seen" value={relativeTime(device.lastSeenAt)} />
        ) : device.codeExpiresAt ? (
          <Fact label="Code" value={`ending ${device.codeHint ?? '····'}`} mono />
        ) : null}
        {activated ? <Fact label="Activated" value={formatDate(device.activatedAt)} /> : null}
        {device.kind === 'payment' && device.lastSaleAt ? (
          <Fact label="Last card sale" value={relativeTime(device.lastSaleAt)} />
        ) : null}
      </dl>

      <footer className="mt-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={() => onManage(device)} data-testid="device-manage">
          <MoreHorizontal className="mr-1.5 h-4 w-4" aria-hidden />
          Manage
        </Button>
      </footer>
    </article>
  )
}
