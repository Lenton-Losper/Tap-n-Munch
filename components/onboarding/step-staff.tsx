'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import type { StepHandle } from './types'

type InviteRow = {
  id: string
  email: string
  role: string
  status: string
  created_at: string
}

type StepStaffProps = {
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepStaff = forwardRef<StepHandle, StepStaffProps>(function StepStaff(
  { onError, setSaving },
  ref
) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'manager' | 'waiter'>('waiter')
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const payload = await onboardingFetch('/api/admin/invites')
        if (!cancelled) setInvites(payload.invites || [])
      } catch {
        // invites table may not exist yet
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSendInvite = async () => {
    const trimmedEmail = email.trim().toLowerCase()
    if (!trimmedEmail) {
      onError('Enter an email address')
      return
    }

    setSending(true)
    onError('')

    try {
      const payload = await onboardingFetch('/api/admin/invites', {
        method: 'POST',
        body: JSON.stringify({ email: trimmedEmail, role }),
      })
      setInvites((prev) => [payload.invite, ...prev])
      setEmail('')
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Failed to send invite')
    } finally {
      setSending(false)
    }
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      setSaving(false)
      return true
    },
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="inviteEmail">Email</Label>
          <Input
            id="inviteEmail"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="staff@example.com"
            className="rounded-lg border-[#E9E9E7]"
          />
        </div>

        <div className="space-y-2">
          <Label>Role</Label>
          <Select value={role} onValueChange={(value) => setRole(value as 'manager' | 'waiter')}>
            <SelectTrigger className="w-full rounded-lg border-[#E9E9E7] sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manager">Manager</SelectItem>
              <SelectItem value="waiter">Waiter</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          onClick={handleSendInvite}
          disabled={sending}
          className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
        >
          {sending ? 'Sending...' : 'Send Invite'}
        </Button>
      </div>

      {invites.length > 0 ? (
        <div className="rounded-lg border border-[#E9E9E7]">
          <div className="border-b border-[#E9E9E7] px-4 py-2 text-sm font-medium text-[#37352F]">
            Pending invites
          </div>
          <ul className="divide-y divide-[#E9E9E7]">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium text-[#37352F]">{invite.email}</p>
                  <p className="capitalize text-[#6B675F]">{invite.role}</p>
                </div>
                <span className="text-[#9B978E]">{invite.status}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-[#6B675F]">
          Invite managers or waiters now, or skip and do this later from your dashboard.
        </p>
      )}
    </div>
  )
})
