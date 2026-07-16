'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { onboardingFetch } from '@/lib/onboarding/api-client'

const PIN_PATTERN = /^[0-9]{4}$/

type PinStaffRow = {
  user_id: string
  role: string
  email: string | null
  name: string | null
  pin_status: 'set' | 'not_set'
  pin_updated_at: string | null
}

function pinEndpoint(restaurantId: string): string {
  return `/api/admin/restaurants/${encodeURIComponent(restaurantId)}/terminal-auth/pin`
}

export function PinsPageContent() {
  const { toast } = useToast()
  const { restaurantId } = useAuth()
  const [staff, setStaff] = useState<PinStaffRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [pinDialogTarget, setPinDialogTarget] = useState<PinStaffRow | null>(null)

  const load = useCallback(async () => {
    if (!restaurantId) return
    try {
      const payload = await onboardingFetch(pinEndpoint(restaurantId))
      setStaff((payload.staff ?? []) as PinStaffRow[])
    } catch {
      toast({ title: 'Failed to load PIN status', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [restaurantId, toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void load()
  }, [load])

  const handlePinSet = (userId: string) => {
    setStaff((prev) =>
      prev.map((member) =>
        member.user_id === userId
          ? { ...member, pin_status: 'set', pin_updated_at: new Date().toISOString() }
          : member,
      ),
    )
  }

  const revokePin = async (member: PinStaffRow) => {
    const label = member.name || member.email || 'this staff member'
    if (!window.confirm(`Revoke the terminal PIN for ${label}? They will not be able to authorize refunds until a new PIN is set.`)) {
      return
    }
    if (!restaurantId) return
    setBusyUserId(member.user_id)
    try {
      await onboardingFetch(pinEndpoint(restaurantId), {
        method: 'DELETE',
        body: JSON.stringify({ target_user_id: member.user_id }),
      })
      setStaff((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, pin_status: 'not_set', pin_updated_at: null } : m,
        ),
      )
      toast({ title: `PIN revoked for ${label}` })
    } catch (error: unknown) {
      toast({
        title: 'Failed to revoke PIN',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setBusyUserId(null)
    }
  }

  if (loading) return <div className="p-8">Loading...</div>

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Terminal PINs</h1>
        <p className="mt-1 text-sm text-[#6B675F]">
          PINs authorize privileged terminal actions (e.g. refunds). PIN values are never shown
          or returned once set — only whether one is set.
        </p>
      </div>

      <div className="border border-[#E9E9E7] rounded-lg divide-y divide-[#E9E9E7]">
        {staff.length === 0 && (
          <p className="p-6 text-gray-500 text-sm text-center">No staff members yet.</p>
        )}
        {staff.map((member) => {
          const label = member.name || member.email || 'Unknown'
          const isBusy = busyUserId === member.user_id
          return (
            <div key={member.user_id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium text-sm">{label}</p>
                <p className="text-xs text-gray-500 capitalize">{member.role}</p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs font-medium px-2 py-1 rounded-full ${
                    member.pin_status === 'set'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {member.pin_status === 'set' ? 'Set' : 'Not set'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => setPinDialogTarget(member)}
                >
                  {member.pin_status === 'set' ? 'Change PIN' : 'Set PIN'}
                </Button>
                {member.pin_status === 'set' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-gray-400 hover:text-red-500"
                    disabled={isBusy}
                    onClick={() => void revokePin(member)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <SetPinDialog
        key={pinDialogTarget?.user_id ?? 'none'}
        member={pinDialogTarget}
        restaurantId={restaurantId}
        onOpenChange={(open) => {
          if (!open) setPinDialogTarget(null)
        }}
        onSuccess={(userId) => {
          handlePinSet(userId)
          setPinDialogTarget(null)
        }}
      />
    </div>
  )
}

type SetPinDialogProps = {
  member: PinStaffRow | null
  restaurantId: string | null
  onOpenChange: (open: boolean) => void
  onSuccess: (userId: string) => void
}

function SetPinDialog({ member, restaurantId, onOpenChange, onSuccess }: SetPinDialogProps) {
  const { toast } = useToast()
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!member || !restaurantId) return
    if (!PIN_PATTERN.test(pin)) {
      setError('PIN must be exactly 4 digits (0-9)')
      return
    }
    if (pin !== confirmPin) {
      setError('PINs do not match')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await onboardingFetch(pinEndpoint(restaurantId), {
        method: 'POST',
        body: JSON.stringify({ target_user_id: member.user_id, pin }),
      })
      const label = member.name || member.email || 'staff member'
      toast({ title: `PIN set for ${label}` })
      onSuccess(member.user_id)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to set PIN')
    } finally {
      setSubmitting(false)
    }
  }

  const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, 4)

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="border-[#E9E9E7] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {member?.pin_status === 'set' ? 'Change' : 'Set'} terminal PIN
          </DialogTitle>
          <DialogDescription>
            {member?.name || member?.email}: enter a new 4-digit PIN for authorizing terminal
            actions (e.g. refunds).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pin-new">New PIN</Label>
            <Input
              id="pin-new"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(digitsOnly(event.target.value))}
              disabled={submitting}
              className="rounded-lg border-[#E9E9E7] tracking-[0.5em]"
              placeholder="0000"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pin-confirm">Confirm PIN</Label>
            <Input
              id="pin-confirm"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={confirmPin}
              onChange={(event) => setConfirmPin(digitsOnly(event.target.value))}
              disabled={submitting}
              className="rounded-lg border-[#E9E9E7] tracking-[0.5em]"
              placeholder="0000"
            />
          </div>
        </div>

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
          >
            {submitting ? 'Saving...' : 'Save PIN'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
