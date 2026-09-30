'use client'

/**
 * SETTINGS -> DEVICES. Every payment terminal and kitchen/bar screen of the restaurant, managed
 * without SQL, DevTools or support: what each physical device is, whether it is connected, when it
 * last checked in, and every lifecycle action -- including approving a device that is registered
 * to another restaurant (the old F19 dead end).
 *
 * All reads and writes go through /api/admin/devices, which resolves the restaurant from the
 * signed-in user's session and checks the permission for each device's kind.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowRightLeft, Plus, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { StationLaunchPanel } from '@/components/settings/station-launch-panel'
import { getSettingsAccessToken } from '@/components/settings/settings-utils'
import {
  LIFECYCLE_LABEL,
  matchesDevice,
  relativeTime,
  sortDevices,
  type DeviceKind,
  type DeviceLifecycle,
  type DeviceSort,
} from '@/lib/devices/device-state'
import type { DeviceView } from '@/lib/devices/device-view'
import { DeviceCard, DeviceStatusBadge } from './device-card'
import { DeviceDetailsDialog, type ConfirmableAction } from './device-details-dialog'
import { AddDeviceDialog, type IssuedCode } from './add-device-dialog'

type Tab = 'payment' | 'screens' | 'codes'
type ListResponse = { devices: DeviceView[]; canManage: Record<DeviceKind, boolean>; restaurantName: string | null }

const CODE_STATES: DeviceLifecycle[] = ['pending', 'code_expired', 'transfer_requested']
const REFRESH_MS = 60_000

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const token = await getSettingsAccessToken()
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  return { ok: res.ok, status: res.status, body }
}

const ACTION_DONE: Record<ConfirmableAction, string> = {
  deactivate: 'Device deactivated.',
  reactivate: 'Device reactivated.',
  revoke: 'Screen disconnected.',
  remove: 'Device removed. It can now be activated with a new code.',
  cancel_code: 'Activation code cancelled.',
  approve_transfer: 'Transfer approved. Tap Activate on the device again with the same code.',
}

export function DevicesConsole() {
  const { toast } = useToast()
  const [data, setData] = useState<ListResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<Tab>('payment')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<DeviceLifecycle | 'all'>('all')
  const [connection, setConnection] = useState<'all' | 'online' | 'offline'>('all')
  const [model, setModel] = useState<string>('all')
  const [sort, setSort] = useState<DeviceSort>('status')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [issued, setIssued] = useState<IssuedCode | null>(null)
  /** When the list was last read. Render never calls Date.now(); "recent" is relative to this. */
  const [loadedAt, setLoadedAt] = useState(0)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await api<ListResponse>('/api/admin/devices')
      if (!res.ok) throw new Error(res.body.error || 'Could not load your devices.')
      setData(res.body)
      setLoadedAt(Date.now())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your devices.')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional data fetch on mount plus a refresh interval; same pattern as settings-payment-tab
    void load()
    const id = window.setInterval(() => void load(), REFRESH_MS)
    return () => window.clearInterval(id)
  }, [load])

  const devices = data?.devices ?? []
  const canManage = data?.canManage ?? { payment: false, kitchen: false, bar: false }
  const allowedKinds = (['payment', 'kitchen', 'bar'] as DeviceKind[]).filter((k) => canManage[k])
  const selected = devices.find((d) => d.id === selectedId) ?? null

  const registered = devices.filter((d) => !CODE_STATES.includes(d.lifecycle))
  const codes = devices.filter((d) => CODE_STATES.includes(d.lifecycle))
  const transferRequests = codes.filter((d) => d.lifecycle === 'transfer_requested' && !d.transferApproved)
  const recentlyActivated = registered
    .filter((d) => d.activatedAt && loadedAt - new Date(d.activatedAt).getTime() < 24 * 60 * 60 * 1000)
    .sort((a, b) => String(b.activatedAt).localeCompare(String(a.activatedAt)))

  const summary = {
    online: registered.filter((d) => d.lifecycle === 'online').length,
    offline: registered.filter((d) => d.lifecycle === 'offline').length,
    attention: registered.filter((d) => d.lifecycle === 'stale').length + transferRequests.length,
    total: registered.length,
  }

  const tabRows = tab === 'payment' ? registered.filter((d) => d.kind === 'payment') : registered.filter((d) => d.kind !== 'payment')
  const models = Array.from(new Set(tabRows.map((d) => d.model))).sort()
  const visible = sortDevices(
    tabRows.filter((d) => matchesDevice(d, { query, lifecycle: status, connection, model })),
    sort,
  )

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast({ title: 'Copied' }),
      () => toast({ title: 'Could not copy', description: text }),
    )
  }

  const runAction = useCallback(
    async (device: DeviceView, action: ConfirmableAction): Promise<boolean> => {
      const res =
        action === 'remove' || action === 'cancel_code'
          ? await api(`/api/admin/devices/${device.id}`, { method: 'DELETE' })
          : await api(`/api/admin/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      if (!res.ok) {
        toast({ title: 'That did not work', description: res.body.error, variant: 'destructive' })
        return false
      }
      toast({ title: ACTION_DONE[action] })
      if (action === 'remove' || action === 'cancel_code') setSelectedId(null)
      await load()
      return true
    },
    [load, toast],
  )

  const rename = useCallback(
    async (device: DeviceView, name: string): Promise<boolean> => {
      const res = await api(`/api/admin/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'rename', name }) })
      if (!res.ok) {
        toast({ title: 'Could not rename', description: res.body.error, variant: 'destructive' })
        return false
      }
      toast({ title: 'Renamed' })
      await load()
      return true
    },
    [load, toast],
  )

  const repair = useCallback(
    async (device: DeviceView) => {
      // Re-pairing a screen keeps its row and name: the existing reissue route (terminal:auth:manage).
      const res = await api<{ activationCode: string; expiresAt: string; name: string }>(
        `/api/admin/terminals/stations/${device.id}/reissue-code`,
        { method: 'POST' },
      )
      if (!res.ok) {
        toast({ title: 'Could not re-pair', description: res.body.error, variant: 'destructive' })
        return
      }
      setSelectedId(null)
      setIssued({ kind: device.kind, name: device.name, activationCode: res.body.activationCode, expiresAt: res.body.expiresAt })
      setAddOpen(true)
      await load()
    },
    [load, toast],
  )

  const issue = useCallback(
    async (kind: DeviceKind, name: string) => {
      const res = await api<{ activationCode: string; expiresAt: string; name: string }>('/api/admin/devices', {
        method: 'POST',
        body: JSON.stringify({ kind, name }),
      })
      if (!res.ok) {
        toast({ title: 'Could not create a code', description: res.body.error, variant: 'destructive' })
        return
      }
      setIssued({ kind, name: res.body.name, activationCode: res.body.activationCode, expiresAt: res.body.expiresAt })
      await load()
    },
    [load, toast],
  )

  const loadActivity = useCallback(async (device: DeviceView) => {
    const res = await api<{ events: Array<{ at: string; action: string; description: string }> }>(
      `/api/admin/devices/${device.id}/activity`,
    )
    return res.ok ? res.body : null
  }, [])

  return (
    <section className="space-y-5 rounded-lg border bg-card p-6" data-testid="devices-console">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Devices</h2>
          <p className="text-sm text-muted-foreground">Manage your payment terminals and kitchen and bar screens.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => void load()} aria-label="Refresh" disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          {allowedKinds.length > 0 ? (
            <Button
              onClick={() => {
                setIssued(null)
                setAddOpen(true)
              }}
              data-testid="add-device"
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add device
            </Button>
          ) : null}
        </div>
      </header>

      {data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="devices-summary">
          {[
            { label: 'Devices', value: summary.total },
            { label: 'Online', value: summary.online },
            { label: 'Offline', value: summary.offline },
            { label: 'Need attention', value: summary.attention },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border p-3">
              <p className="text-2xl font-semibold">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      ) : null}

      {transferRequests.map((d) => (
        <div
          key={d.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 p-4"
          data-testid="transfer-request"
        >
          <div className="flex items-start gap-3">
            <ArrowRightLeft className="mt-0.5 h-5 w-5 text-sky-700" aria-hidden />
            <div>
              <p className="font-medium text-sky-900">A device registered to another restaurant wants to join</p>
              <p className="text-sm text-sky-800">
                It used your code ending <span className="font-mono">{d.codeHint}</span>{' '}
                {d.transferRequestedAt ? relativeTime(d.transferRequestedAt).toLowerCase() : ''}. Approve only if it is the device in front of you.
              </p>
            </div>
          </div>
          <Button onClick={() => setSelectedId(d.id)}>Review transfer</Button>
        </div>
      ))}

      {loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {loadError}{' '}
          <button className="underline" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {canManage.payment ? <TabsTrigger value="payment">Payment terminals</TabsTrigger> : null}
          {canManage.kitchen || canManage.bar ? <TabsTrigger value="screens">Kitchen &amp; bar screens</TabsTrigger> : null}
          <TabsTrigger value="codes">
            Activation codes{codes.length ? ` (${codes.length})` : ''}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab !== 'codes' ? (
        <>
          <div className="flex flex-wrap gap-2" data-testid="devices-controls">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input
                className="pl-8"
                placeholder="Search name, serial, device ID or model"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search devices"
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as DeviceLifecycle | 'all')}>
              <SelectTrigger className="w-[11rem]" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(['online', 'offline', 'stale', 'never_activated', 'deactivated', 'revoked'] as DeviceLifecycle[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {LIFECYCLE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={connection} onValueChange={(v) => setConnection(v as 'all' | 'online' | 'offline')}>
              <SelectTrigger className="w-[10rem]" aria-label="Connection">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Online or offline</SelectItem>
                <SelectItem value="online">Online only</SelectItem>
                <SelectItem value="offline">Offline only</SelectItem>
              </SelectContent>
            </Select>
            {models.length > 1 ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-[11rem]" aria-label="Model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All models</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Select value={sort} onValueChange={(v) => setSort(v as DeviceSort)}>
              <SelectTrigger className="w-[11rem]" aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="status">Sort by status</SelectItem>
                <SelectItem value="last_seen">Sort by last seen</SelectItem>
                <SelectItem value="name">Sort by name</SelectItem>
                <SelectItem value="activated">Sort by activation date</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!data && !loadError ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-44 rounded-xl" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="devices-empty">
              {tabRows.length === 0
                ? tab === 'payment'
                  ? 'No payment terminals yet. Choose Add device to set one up.'
                  : 'No kitchen or bar screens yet. Choose Add device to pair one.'
                : 'No devices match these filters.'}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="devices-grid">
              {visible.map((d) => (
                <DeviceCard key={d.id} device={d} onManage={(dev) => setSelectedId(dev.id)} />
              ))}
            </div>
          )}

          {tab === 'screens' ? <StationLaunchPanel /> : null}
        </>
      ) : (
        <div className="space-y-6" data-testid="codes-panel">
          {codes.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No open activation codes.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {codes.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="code-row">
                  <div className="min-w-0">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Code ending <span className="font-mono">{d.codeHint}</span> · created {relativeTime(d.createdAt).toLowerCase()}
                      {d.codeExpiresAt ? ` · expires ${new Date(d.codeExpiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <DeviceStatusBadge lifecycle={d.lifecycle} />
                    <Button variant="outline" size="sm" onClick={() => setSelectedId(d.id)}>
                      {d.lifecycle === 'transfer_requested' ? 'Review' : 'Manage'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {recentlyActivated.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Activated in the last 24 hours</h3>
              <ul className="space-y-1 text-sm" data-testid="recently-activated">
                {recentlyActivated.map((d) => (
                  <li key={d.id}>
                    Activated by {d.model} — <span className="font-medium">{d.name}</span>{' '}
                    <span className="text-muted-foreground">{relativeTime(d.activatedAt).toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A full code is shown only once, when it is created. To get a code you can copy again, cancel this one and add the device again.
          </p>
        </div>
      )}

      {selected ? (
      <DeviceDetailsDialog
        key={selected.id}
        device={selected}
        restaurantName={data?.restaurantName ?? null}
        onClose={() => setSelectedId(null)}
        onRename={rename}
        onAction={runAction}
        onRepair={repair}
        loadActivity={loadActivity}
      />
      ) : null}
      {addOpen ? (
      <AddDeviceDialog
        open
        allowedKinds={allowedKinds}
        issued={issued}
        onClose={() => {
          setAddOpen(false)
          setIssued(null)
        }}
        onIssue={issue}
        onCopy={copy}
      />
      ) : null}
    </section>
  )
}
