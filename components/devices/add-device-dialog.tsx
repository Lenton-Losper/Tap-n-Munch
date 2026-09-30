'use client'

/**
 * Add a device: choose what it is, name it, get its activation code. The full code is shown HERE and
 * nowhere else (the list only ever shows its last four characters), so this dialog offers Copy and
 * Share, and -- for a kitchen or bar screen -- the one-click pairing link that carries the same code.
 */
import { useEffect, useState } from 'react'
import { Copy, Loader2, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { stationActivationLink } from '@/lib/stations/activation-link'
import type { DeviceKind } from '@/lib/devices/device-state'
import { DeviceKindIcon } from './device-card'

export type IssuedCode = { kind: DeviceKind; name: string; activationCode: string; expiresAt: string }

const KIND_LABEL: Record<DeviceKind, { title: string; hint: string }> = {
  payment: { title: 'Payment terminal', hint: 'A P5 that takes orders and card payments.' },
  kitchen: { title: 'Kitchen screen', hint: 'A screen that shows kitchen tickets.' },
  bar: { title: 'Bar screen', hint: 'A screen that shows bar tickets.' },
}

function minutesLeft(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return 'This code has expired.'
  const min = Math.ceil(ms / 60_000)
  return `Expires in ${min} minute${min === 1 ? '' : 's'}.`
}

type Props = {
  open: boolean
  allowedKinds: DeviceKind[]
  issued: IssuedCode | null
  onClose: () => void
  onIssue: (kind: DeviceKind, name: string) => Promise<void>
  onCopy: (text: string) => void
}

export function AddDeviceDialog({ open, allowedKinds, issued, onClose, onIssue, onCopy }: Props) {
  const [kind, setKind] = useState<DeviceKind>(allowedKinds[0] ?? 'payment')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!issued) return
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [issued])

  const link =
    issued && issued.kind !== 'payment' && typeof window !== 'undefined'
      ? stationActivationLink(issued.kind, issued.activationCode, window.location.origin)
      : null

  const share = async () => {
    if (!issued) return
    const text = link
      ? `Open ${link} on the screen to pair it, or enter code ${issued.activationCode}.`
      : `FlashTap activation code: ${issued.activationCode}`
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'FlashTap activation code', text })
        return
      } catch {
        // Cancelled or unsupported: fall back to copying.
      }
    }
    onCopy(text)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md" data-testid="add-device-dialog">
        {!issued ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a device</DialogTitle>
              <DialogDescription>Choose what you are setting up. You will get a one-hour activation code.</DialogDescription>
            </DialogHeader>
            <RadioGroup value={kind} onValueChange={(v) => setKind(v as DeviceKind)} className="space-y-2">
              {allowedKinds.map((k) => (
                <label
                  key={k}
                  htmlFor={`add-device-${k}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted/50"
                >
                  <RadioGroupItem id={`add-device-${k}`} value={k} />
                  <DeviceKindIcon kind={k} className="h-5 w-5 text-muted-foreground" />
                  <span>
                    <span className="block font-medium">{KIND_LABEL[k].title}</span>
                    <span className="block text-sm text-muted-foreground">{KIND_LABEL[k].hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <div className="space-y-2">
              <Label htmlFor="add-device-name">Name (optional)</Label>
              <Input
                id="add-device-name"
                value={name}
                maxLength={60}
                placeholder={kind === 'payment' ? 'e.g. Front till' : kind === 'kitchen' ? 'e.g. Pass' : 'e.g. Main bar'}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                data-testid="add-device-issue"
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onIssue(kind, name.trim())
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Get activation code'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Activation code for {issued.name}</DialogTitle>
              <DialogDescription>
                {issued.kind === 'payment'
                  ? 'Open the FlashTap Terminal app on the device and enter this code.'
                  : 'Open the pairing link on the screen, or enter this code on its sign-in page.'}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-xl border bg-muted/40 p-5 text-center">
              <p className="font-mono text-3xl font-bold tracking-widest" data-testid="issued-code">
                {issued.activationCode}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{minutesLeft(issued.expiresAt, now)}</p>
              <p className="mt-1 text-xs text-muted-foreground">This is the only time the full code is shown.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => onCopy(issued.activationCode)}>
                <Copy className="mr-1.5 h-4 w-4" aria-hidden /> Copy code
              </Button>
              <Button variant="outline" onClick={() => void share()}>
                <Share2 className="mr-1.5 h-4 w-4" aria-hidden /> Share
              </Button>
              {link ? (
                <Button variant="outline" onClick={() => onCopy(link)}>
                  <Copy className="mr-1.5 h-4 w-4" aria-hidden /> Copy pairing link
                </Button>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
