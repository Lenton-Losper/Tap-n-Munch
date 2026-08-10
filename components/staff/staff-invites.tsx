'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import {
  fetchRestaurantRoles,
  filterInviteEligibleRoles,
  type RestaurantRoleOption,
} from '@/components/staff/restaurant-roles-client'

/**
 * Not a database column. staff_invites stores `accepted boolean`; both invite routes
 * derive this field as `row.accepted ? 'accepted' : 'pending'` (app/api/admin/invites),
 * so these two values are the whole vocabulary and it is our code, not the schema, that
 * decides it.
 */
export type StaffInviteStatus = 'pending' | 'accepted'

export type StaffInviteRow = {
  id: string
  email: string
  role: string
  status: StaffInviteStatus
  created_at?: string
}

export function useStaffInvites() {
  const [invites, setInvites] = useState<StaffInviteRow[]>([])
  const [loading, setLoading] = useState(true)

  const loadInvites = useCallback(async () => {
    try {
      const payload = await onboardingFetch('/api/admin/invites')
      setInvites(payload.invites || [])
    } catch {
      // invites table may not exist yet
    } finally {
      setLoading(false)
    }
  }, [])

  const addInvite = useCallback((invite: StaffInviteRow) => {
    setInvites((prev) => [invite, ...prev])
  }, [])

  const removeInvite = useCallback((inviteId: string) => {
    setInvites((prev) => prev.filter((invite) => invite.id !== inviteId))
  }, [])

  const cancelInvite = useCallback(async (inviteId: string) => {
    await onboardingFetch(`/api/admin/invites/${encodeURIComponent(inviteId)}`, {
      method: 'DELETE',
    })
    removeInvite(inviteId)
  }, [removeInvite])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void loadInvites()
  }, [loadInvites])

  return { invites, loading, loadInvites, addInvite, removeInvite, cancelInvite }
}

type StaffInviteFormProps = {
  onError?: (message: string) => void
  onSuccess?: (invite: StaffInviteRow) => void
  layout?: 'inline' | 'stacked'
  idPrefix?: string
  submitLabel?: string
}

export function StaffInviteForm({
  onError,
  onSuccess,
  layout = 'inline',
  idPrefix = 'staff-invite',
  submitLabel = 'Send Invite',
}: StaffInviteFormProps) {
  const [email, setEmail] = useState('')
  const [inviteRoles, setInviteRoles] = useState<RestaurantRoleOption[]>([])
  const [role, setRole] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const roles = filterInviteEligibleRoles(await fetchRestaurantRoles())
        if (cancelled) return
        setInviteRoles(roles)
        const preferred = roles.find((r) => r.role_slug === 'waiter') ?? roles[0]
        if (preferred) setRole(preferred.role_slug)
      } catch {
        if (!cancelled) onError?.('Failed to load invite roles')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [onError])

  const handleSendInvite = async () => {
    const trimmedEmail = email.trim().toLowerCase()
    if (!trimmedEmail) {
      onError?.('Enter an email address')
      return
    }
    if (!role) {
      onError?.('Select a role')
      return
    }

    setSending(true)
    onError?.('')

    try {
      const payload = await onboardingFetch('/api/admin/invites', {
        method: 'POST',
        body: JSON.stringify({ email: trimmedEmail, role }),
      })
      const invite = payload.invite as StaffInviteRow
      setEmail('')
      onSuccess?.(invite)
    } catch (error: unknown) {
      onError?.(error instanceof Error ? error.message : 'Failed to send invite')
    } finally {
      setSending(false)
    }
  }

  const emailField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-email`}>Email</Label>
      <Input
        id={`${idPrefix}-email`}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="staff@example.com"
        disabled={sending}
        className="rounded-lg border-[#E9E9E7]"
      />
    </div>
  )

  const roleField = (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-role`}>Role</Label>
      <Select
        value={role}
        onValueChange={setRole}
        disabled={sending || inviteRoles.length === 0}
      >
        <SelectTrigger id={`${idPrefix}-role`} className="w-full rounded-lg border-[#E9E9E7] sm:w-36">
          <SelectValue placeholder="Role" />
        </SelectTrigger>
        <SelectContent>
          {inviteRoles.map((inviteRole) => (
            <SelectItem key={inviteRole.role_slug} value={inviteRole.role_slug}>
              {inviteRole.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const submitButton = (
    <Button
      type="button"
      onClick={handleSendInvite}
      disabled={sending}
      className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
    >
      {sending ? 'Sending...' : submitLabel}
    </Button>
  )

  if (layout === 'stacked') {
    return (
      <div className="space-y-4">
        {emailField}
        {roleField}
        {submitButton}
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
      {emailField}
      {roleField}
      {submitButton}
    </div>
  )
}

type PendingInvitesListProps = {
  invites: StaffInviteRow[]
  title?: string
  emptyMessage?: string
  onCancelInvite?: (invite: StaffInviteRow) => Promise<void>
  cancellingId?: string | null
}

export function PendingInvitesList({
  invites,
  title = 'Pending invites',
  emptyMessage,
  onCancelInvite,
  cancellingId = null,
}: PendingInvitesListProps) {
  const pending = invites.filter((invite) => invite.status === 'pending')

  if (pending.length === 0) {
    return emptyMessage ? <p className="text-sm text-[#6B675F]">{emptyMessage}</p> : null
  }

  return (
    <div className="rounded-lg border border-[#E9E9E7]">
      <div className="border-b border-[#E9E9E7] px-4 py-2 text-sm font-medium text-[#37352F]">
        {title}
      </div>
      <ul className="divide-y divide-[#E9E9E7]">
        {pending.map((invite) => (
          <li key={invite.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-[#37352F]">{invite.email}</p>
              <p className="capitalize text-[#6B675F]">{invite.role}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[#9B978E]">{invite.status}</span>
              {onCancelInvite ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-[#6B675F] hover:text-red-600"
                  disabled={cancellingId === invite.id}
                  onClick={async () => {
                    const confirmed = window.confirm(
                      `Cancel the invite for ${invite.email}? They will no longer be able to use the invitation link.`,
                    )
                    if (!confirmed) return
                    await onCancelInvite(invite)
                  }}
                >
                  {cancellingId === invite.id ? 'Cancelling...' : 'Cancel'}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

type InviteStaffDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInviteSent?: (invite: StaffInviteRow) => void
}

export function InviteStaffDialog({ open, onOpenChange, onInviteSent }: InviteStaffDialogProps) {
  const [error, setError] = useState('')

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setError('')
    onOpenChange(nextOpen)
  }

  const handleSuccess = (invite: StaffInviteRow) => {
    onInviteSent?.(invite)
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-[#E9E9E7] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite staff</DialogTitle>
          <DialogDescription>
            Send an invitation email. They will set a password when they accept.
          </DialogDescription>
        </DialogHeader>

        <StaffInviteForm
          layout="stacked"
          idPrefix="invite-dialog"
          onError={setError}
          onSuccess={handleSuccess}
        />

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
