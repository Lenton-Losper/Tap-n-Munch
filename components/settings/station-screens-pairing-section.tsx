'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Copy, Monitor, Plus } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { usePermissions } from '@/hooks/use-permissions'
import { PERMISSIONS } from '@/lib/permissions'
import { STATION_KINDS, type StationKind } from '@/lib/stations/station-pairing'
import { STATION_PAIRING_COPY as COPY } from '@/lib/stations/pairing-copy'
import { StationLaunchPanel } from '@/components/settings/station-launch-panel'
import { getSettingsAccessToken } from './settings-utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'

type PairedScreen = {
  id: string
  name: string
  station: StationKind
  status: string
  active: boolean
  activatedAt: string | null
  lastSeenAt: string | null
  hasPendingCode: boolean
  codeExpiresAt: string | null
}

type IssuedCode = {
  id: string
  name: string
  station: StationKind
  activationCode: string
  expiresAt: string
}

async function authedFetch(path: string, init?: RequestInit) {
  const token = await getSettingsAccessToken()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload?.error || 'Request failed')
  }
  return payload
}

/** "MM:SS", floored at 00:00 — never negative, so an expired code reads as 00:00 not -00:04. */
function formatCountdown(expiresAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - nowMs)
  const totalSeconds = Math.floor(remainingMs / 1000)
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const ss = String(totalSeconds % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function statusBadge(screen: PairedScreen) {
  if (screen.status === 'active') {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">{COPY.status.active}</Badge>
  }
  if (screen.status === 'revoked') {
    return <Badge variant="destructive">{COPY.status.revoked}</Badge>
  }
  if (screen.status === 'pending') {
    return <Badge variant="secondary">{COPY.status.pending}</Badge>
  }
  return <Badge variant="outline">{COPY.status.inactive}</Badge>
}

function CodeDialog({
  issued,
  onClose,
}: {
  issued: IssuedCode
  onClose: () => void
}) {
  const { toast } = useToast()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const expired = new Date(issued.expiresAt).getTime() <= nowMs
  const stationLabel = COPY.station[issued.station]

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(issued.activationCode)
      setCopied(true)
      toast({ title: COPY.toast.copied })
    } catch {
      toast({ title: COPY.toast.copyFailed, variant: 'destructive' })
    }
  }

  const requestClose = () => {
    if (copied) {
      onClose()
      return
    }
    setConfirmingClose(true)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        {confirmingClose ? (
          <>
            <DialogHeader>
              <DialogTitle>{COPY.codeIssued.closeConfirmHeading}</DialogTitle>
              <DialogDescription>{COPY.codeIssued.closeConfirmBody}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setConfirmingClose(false)}>
                {COPY.codeIssued.closeConfirmDismiss}
              </Button>
              <Button variant="destructive" onClick={onClose}>
                {COPY.codeIssued.closeConfirmProceed}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Monitor className="h-5 w-5" />
                {COPY.codeIssued.heading}
              </DialogTitle>
            </DialogHeader>

            <p
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
              data-testid="code-once-warning"
            >
              {COPY.codeIssued.onceWarning}
            </p>

            <p className="text-sm text-muted-foreground">{COPY.codeIssued.instructions(stationLabel)}</p>

            <div className="rounded-lg border bg-muted/40 px-4 py-6 text-center">
              <p className="font-mono text-3xl font-semibold tracking-widest" data-testid="issued-code">
                {issued.activationCode}
              </p>
              <p
                className={`mt-2 text-xs font-medium ${expired ? 'text-red-600' : 'text-muted-foreground'}`}
                data-testid="code-countdown"
              >
                {expired ? COPY.codeIssued.expired : COPY.codeIssued.expiresIn(formatCountdown(issued.expiresAt, nowMs))}
              </p>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={handleCopy}>
                <Copy className="mr-2 h-4 w-4" />
                {copied ? COPY.codeIssued.copiedButton : COPY.codeIssued.copyButton}
              </Button>
              <Button onClick={requestClose}>{COPY.codeIssued.closeButton}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function StationScreensPairingSection() {
  const { toast } = useToast()
  const { restaurantId } = useAuth()
  const { hasPermission, permissionsLoaded } = usePermissions()
  const canManage = !permissionsLoaded || hasPermission(PERMISSIONS.TERMINAL_AUTH_MANAGE)

  const [screens, setScreens] = useState<PairedScreen[]>([])
  const [loading, setLoading] = useState(true)

  const [chooseOpen, setChooseOpen] = useState(false)
  const [chooseStation, setChooseStation] = useState<StationKind>('kitchen')
  const [chooseName, setChooseName] = useState('')
  const [pairing, setPairing] = useState(false)

  const [issued, setIssued] = useState<IssuedCode | null>(null)

  const [revokeTarget, setRevokeTarget] = useState<PairedScreen | null>(null)
  const [revoking, setRevoking] = useState(false)

  const [reissueTarget, setReissueTarget] = useState<PairedScreen | null>(null)
  const [reissuing, setReissuing] = useState(false)

  const loadScreens = useCallback(async () => {
    if (!restaurantId) return
    try {
      setLoading(true)
      const payload = await authedFetch('/api/admin/terminals/stations')
      setScreens(payload.screens || [])
    } catch (error: unknown) {
      toast({
        title: COPY.toast.loadFailed,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch
    void loadScreens()
  }, [loadScreens])

  const openChoose = () => {
    setChooseStation('kitchen')
    setChooseName('')
    setChooseOpen(true)
  }

  const handlePair = async () => {
    try {
      setPairing(true)
      const payload = await authedFetch('/api/admin/terminals/stations', {
        method: 'POST',
        body: JSON.stringify({ station: chooseStation, name: chooseName.trim() || undefined }),
      })
      setChooseOpen(false)
      setIssued(payload)
      toast({ title: COPY.toast.paired })
      await loadScreens()
    } catch (error: unknown) {
      toast({
        title: COPY.toast.pairFailed,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setPairing(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    try {
      setRevoking(true)
      await authedFetch(`/api/admin/terminals/stations/${encodeURIComponent(revokeTarget.id)}/revoke`, {
        method: 'POST',
      })
      toast({ title: COPY.toast.revoked(revokeTarget.name) })
      setRevokeTarget(null)
      await loadScreens()
    } catch (error: unknown) {
      toast({
        title: COPY.toast.revokeFailed,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setRevoking(false)
    }
  }

  const handleReissue = async () => {
    if (!reissueTarget) return
    try {
      setReissuing(true)
      const payload = await authedFetch(
        `/api/admin/terminals/stations/${encodeURIComponent(reissueTarget.id)}/reissue-code`,
        { method: 'POST' },
      )
      setReissueTarget(null)
      setIssued(payload)
      toast({ title: COPY.toast.reissued })
      await loadScreens()
    } catch (error: unknown) {
      toast({
        title: COPY.toast.reissueFailed,
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setReissuing(false)
    }
  }

  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  const rows = useMemo(
    () =>
      screens.map((screen) => {
        const pending = screen.hasPendingCode && screen.codeExpiresAt && new Date(screen.codeExpiresAt).getTime() > nowMs
        const codeExpired = screen.status === 'pending' && !pending
        return { screen, pending, codeExpired }
      }),
    [screens, nowMs],
  )

  if (!canManage) {
    return (
      <div className="bg-card border rounded-lg p-6" data-testid="station-pairing-permission-denied">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Monitor className="h-5 w-5" />
          {COPY.section.heading}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{COPY.permission.denied}</p>
      </div>
    )
  }

  return (
    <div className="bg-card border rounded-lg p-6 space-y-6" data-testid="station-pairing-section">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            {COPY.section.heading}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{COPY.section.description}</p>
        </div>
        <Button onClick={openChoose} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          {COPY.section.pairButton}
        </Button>
      </div>

      {/* Install first, pair second — one job, one place. See StationLaunchPanel. */}
      <StationLaunchPanel />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{COPY.list.emptyHeading}</p>
          <p className="mt-1 text-sm text-muted-foreground">{COPY.list.emptyBody}</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="paired-screens-list">
          {rows.map(({ screen, pending, codeExpired }) => (
            <div
              key={screen.id}
              className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid="paired-screen-row"
              data-station={screen.station}
              data-status={screen.status}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{screen.name}</p>
                  <Badge variant="outline">{COPY.station[screen.station]}</Badge>
                  {statusBadge(screen)}
                </div>
                <p className="text-sm text-muted-foreground">
                  {screen.activatedAt
                    ? COPY.list.pairedAt(formatDistanceToNow(new Date(screen.activatedAt), { addSuffix: true }))
                    : COPY.list.pairedNever}
                </p>
                <p className="text-sm text-muted-foreground">
                  {COPY.list.columnLastSeen}:{' '}
                  {screen.lastSeenAt
                    ? COPY.list.lastSeenAt(formatDistanceToNow(new Date(screen.lastSeenAt), { addSuffix: true }))
                    : COPY.list.lastSeenNever}
                </p>
                {pending && screen.codeExpiresAt ? (
                  <p className="text-xs font-medium text-amber-700">
                    {COPY.list.waitingForCode(formatCountdown(screen.codeExpiresAt, nowMs))}
                  </p>
                ) : codeExpired ? (
                  <p className="text-xs font-medium text-red-600">{COPY.list.codeExpired}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReissueTarget(screen)}
                  disabled={reissuing}
                >
                  {COPY.list.reissueButton}
                </Button>
                {screen.status !== 'revoked' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => setRevokeTarget(screen)}
                    disabled={revoking}
                  >
                    {COPY.list.revokeButton}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Step 1: choose the station */}
      <Dialog open={chooseOpen} onOpenChange={setChooseOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{COPY.choose.heading}</DialogTitle>
            <DialogDescription>{COPY.choose.instructions}</DialogDescription>
          </DialogHeader>

          <RadioGroup value={chooseStation} onValueChange={(v) => setChooseStation(v as StationKind)}>
            {STATION_KINDS.map((kind) => (
              <label
                key={kind}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
              >
                <RadioGroupItem value={kind} className="mt-1" />
                <span>
                  <span className="block font-medium">
                    {kind === 'kitchen' ? COPY.choose.kitchenLabel : COPY.choose.barLabel}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {kind === 'kitchen' ? COPY.choose.kitchenHint : COPY.choose.barHint}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>

          <div className="space-y-1.5">
            <Label htmlFor="station-screen-name">{COPY.choose.nameLabel}</Label>
            <Input
              id="station-screen-name"
              value={chooseName}
              onChange={(e) => setChooseName(e.target.value)}
              placeholder={COPY.choose.namePlaceholder(
                chooseStation === 'kitchen' ? COPY.defaultName.kitchen : COPY.defaultName.bar,
              )}
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setChooseOpen(false)}>
              {COPY.choose.cancelButton}
            </Button>
            <Button onClick={handlePair} disabled={pairing}>
              {pairing ? COPY.choose.generatingButton : COPY.choose.generateButton}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step 2: the one-time code */}
      {issued ? <CodeDialog issued={issued} onClose={() => setIssued(null)} /> : null}

      {/* Revoke confirmation */}
      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {revokeTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>{COPY.revokeConfirm.heading(revokeTarget.name)}</DialogTitle>
                <DialogDescription>{COPY.revokeConfirm.body}</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-amber-700" data-testid="revoke-disruption-warning">
                {COPY.disruptionWarning}
              </p>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setRevokeTarget(null)}>
                  {COPY.revokeConfirm.cancelButton}
                </Button>
                <Button variant="destructive" onClick={handleRevoke} disabled={revoking}>
                  {revoking ? COPY.list.revokingButton : COPY.revokeConfirm.confirmButton}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Reissue confirmation */}
      <Dialog open={reissueTarget !== null} onOpenChange={(open) => !open && setReissueTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {reissueTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>{COPY.reissueConfirm.heading(reissueTarget.name)}</DialogTitle>
                <DialogDescription>{COPY.reissueConfirm.body}</DialogDescription>
              </DialogHeader>
              <p className="text-sm text-amber-700" data-testid="reissue-disruption-warning">
                {COPY.disruptionWarning}
              </p>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setReissueTarget(null)}>
                  {COPY.reissueConfirm.cancelButton}
                </Button>
                <Button onClick={handleReissue} disabled={reissuing}>
                  {reissuing ? COPY.list.reissuingButton : COPY.reissueConfirm.confirmButton}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
