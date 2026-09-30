'use client'

/**
 * Everything about one device, and every action on it -- normal actions up top, destructive ones
 * apart at the bottom, each behind a confirmation that says exactly what will happen.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ACTION_COPY } from '@/lib/devices/device-copy'
import { LIFECYCLE_EXPLANATION, relativeTime, type DeviceAction } from '@/lib/devices/device-state'
import type { DeviceView } from '@/lib/devices/device-view'
import { DeviceKindIcon, DeviceStatusBadge, formatDate } from './device-card'

export type ConfirmableAction = Exclude<DeviceAction, 'rename'>

type ActivityEvent = { at: string; action: string; description: string }

type Props = {
  device: DeviceView
  restaurantName: string | null
  onClose: () => void
  onRename: (device: DeviceView, name: string) => Promise<boolean>
  onAction: (device: DeviceView, action: ConfirmableAction) => Promise<boolean>
  onRepair: (device: DeviceView) => Promise<void>
  loadActivity: (device: DeviceView) => Promise<{ events: ActivityEvent[] } | null>
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-all ${mono ? 'font-mono text-xs leading-5' : ''}`}>{value}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <dl>{children}</dl>
    </section>
  )
}

const DESTRUCTIVE: ConfirmableAction[] = ['deactivate', 'revoke', 'remove', 'cancel_code']

export function DeviceDetailsDialog({ device, restaurantName, onClose, onRename, onAction, onRepair, loadActivity }: Props) {
  // Mounted afresh per device (the console keys it by id), so initial state IS the reset.
  const [name, setName] = useState(device.customName ?? '')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState<ConfirmableAction | null>(null)
  const [working, setWorking] = useState(false)
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadActivity(device).then((res) => {
      if (!cancelled) setActivity(res?.events ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [device, loadActivity])

  const handleRename = useCallback(async () => {
    setSaving(true)
    try {
      await onRename(device, name)
    } finally {
      setSaving(false)
    }
  }, [device, name, onRename])

  const can = (a: DeviceAction) => device.actions.includes(a)
  const isScreen = device.kind !== 'payment'
  const canRepair = isScreen && ['revoked', 'stale', 'offline', 'code_expired'].includes(device.lifecycle)
  const confirmCopy = confirming ? ACTION_COPY[confirming] : null
  const normalActions: ConfirmableAction[] = (['approve_transfer', 'reactivate'] as ConfirmableAction[]).filter(can)
  const dangerActions = DESTRUCTIVE.filter(can)

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="device-details">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <DeviceKindIcon kind={device.kind} />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{device.name}</DialogTitle>
              <DialogDescription>{device.model}</DialogDescription>
            </div>
            <DeviceStatusBadge lifecycle={device.lifecycle} />
          </div>
        </DialogHeader>

        <p className="rounded-lg bg-muted/60 p-3 text-sm" data-testid="device-explanation">
          {LIFECYCLE_EXPLANATION[device.lifecycle]}
        </p>

        <div className="space-y-5">
          <Section title="Identity">
            <Row label="Name" value={device.name} />
            <Row label="Model" value={device.model} />
            <Row label="Serial" value={device.serial ?? 'Not reported by the device'} mono={Boolean(device.serial)} />
            <Row label="Device ID" value={device.deviceId ?? '—'} mono={Boolean(device.deviceId)} />
          </Section>

          <Section title="Connection">
            <Row label="Last seen" value={device.activatedAt ? relativeTime(device.lastSeenAt) : 'Never connected'} />
            <Row label="App version" value={device.appVersion ?? '—'} />
            {device.kind === 'payment' ? (
              <Row label="Last card sale" value={device.lastSaleAt ? relativeTime(device.lastSaleAt) : 'None in 30 days'} />
            ) : null}
          </Section>

          <Section title="Restaurant">
            <Row label="Registered to" value={restaurantName ?? 'This restaurant'} />
            <Row label="Activated" value={formatDate(device.activatedAt)} />
            <Row label="Added" value={formatDate(device.createdAt)} />
          </Section>

          <Section title="Activity">
            {activity === null ? (
              <p className="py-1 text-sm text-muted-foreground">Loading…</p>
            ) : activity.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">No recorded changes yet.</p>
            ) : (
              <ol className="space-y-1" data-testid="device-activity">
                {activity.slice(0, 8).map((e) => (
                  <li key={`${e.at}-${e.action}`} className="flex justify-between gap-3 text-sm">
                    <span>{e.description}</span>
                    <span className="shrink-0 text-muted-foreground">{relativeTime(e.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {can('rename') ? (
            <>
              <Separator />
              <section className="space-y-2">
                <Label htmlFor="device-name-input">Name</Label>
                <div className="flex gap-2">
                  <Input
                    id="device-name-input"
                    value={name}
                    maxLength={60}
                    placeholder="e.g. Kitchen P5, Front till"
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Button onClick={handleRename} disabled={saving || !name.trim() || name.trim() === device.customName}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Rename'}
                  </Button>
                </div>
              </section>
            </>
          ) : null}

          {normalActions.length > 0 || canRepair ? (
            <div className="flex flex-wrap gap-2">
              {normalActions.map((a) => (
                <Button key={a} onClick={() => setConfirming(a)} data-testid={`device-action-${a}`}>
                  {ACTION_COPY[a].confirm}
                </Button>
              ))}
              {canRepair ? (
                <Button variant="outline" onClick={() => void onRepair(device)} data-testid="device-action-repair">
                  Re-pair screen
                </Button>
              ) : null}
            </div>
          ) : null}

          {dangerActions.length > 0 ? (
            <section className="space-y-2 rounded-lg border border-red-200 p-3" data-testid="device-danger-zone">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-red-700">Danger zone</h4>
              <div className="flex flex-wrap gap-2">
                {dangerActions.map((a) => (
                  <Button
                    key={a}
                    variant="outline"
                    size="sm"
                    className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                    onClick={() => setConfirming(a)}
                    data-testid={`device-action-${a}`}
                  >
                    {ACTION_COPY[a].confirm}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {confirmCopy && confirming ? (
          <div className="mt-2 space-y-3 rounded-lg border bg-muted/40 p-4" role="alertdialog" data-testid="device-confirm">
            <p className="font-semibold">{confirmCopy.title}</p>
            <p className="text-sm text-muted-foreground">{confirmCopy.body}</p>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setConfirming(null)} disabled={working}>
                Cancel
              </Button>
              <Button
                variant={DESTRUCTIVE.includes(confirming) ? 'destructive' : 'default'}
                disabled={working}
                data-testid="device-confirm-button"
                onClick={async () => {
                  setWorking(true)
                  try {
                    if (await onAction(device, confirming)) setConfirming(null)
                  } finally {
                    setWorking(false)
                  }
                }}
              >
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmCopy.confirm}
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
