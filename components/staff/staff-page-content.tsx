'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Trash2, UserPlus } from 'lucide-react'
import { getAccessToken } from '@/lib/onboarding/api-client'
import {
  InviteStaffDialog,
  PendingInvitesList,
  useStaffInvites,
  type StaffInviteRow,
} from '@/components/staff/staff-invites'
import {
  fetchRestaurantRoles,
  filterStaffAssignableRoles,
  type RestaurantRoleOption,
} from '@/components/staff/restaurant-roles-client'

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-purple-100 text-purple-800',
  manager: 'bg-blue-100 text-blue-800',
  cashier: 'bg-green-100 text-green-800',
  waiter: 'bg-yellow-100 text-yellow-800',
  kitchen: 'bg-orange-100 text-orange-800',
  bar: 'bg-slate-100 text-slate-800',
}

interface StaffMember {
  id: string
  user_id: string
  role: string
  invite_accepted: boolean
  users: { email: string; name: string } | null
}

export function StaffPageContent() {
  const { toast } = useToast()
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [assignableRoles, setAssignableRoles] = useState<RestaurantRoleOption[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(null)
  const { invites, addInvite, loadInvites, cancelInvite } = useStaffInvites()

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      const [staffRes, roles] = await Promise.all([
        fetch('/api/admin/staff', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetchRestaurantRoles(),
      ])
      const data = await staffRes.json()
      setStaff(data.staff ?? [])
      setAssignableRoles(filterStaffAssignableRoles(roles))
    } catch {
      toast({ title: 'Failed to load staff', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch; React Query refactor out of scope
    void load()
  }, [load])

  const handleInviteSent = async (invite: StaffInviteRow) => {
    addInvite(invite)
    await loadInvites()
    toast({
      title: 'Invite sent',
      description: `Invitation sent to ${invite.email}.`,
    })
  }

  const handleCancelInvite = async (invite: StaffInviteRow) => {
    setCancellingInviteId(invite.id)
    try {
      await cancelInvite(invite.id)
      toast({
        title: 'Invite cancelled',
        description: `The invitation for ${invite.email} is no longer valid.`,
      })
    } catch {
      await loadInvites()
      toast({ title: 'Failed to cancel invite', variant: 'destructive' })
    } finally {
      setCancellingInviteId(null)
    }
  }

  const changeRole = async (userId: string, role: string) => {
    setUpdating(userId)
    try {
      const token = await getAccessToken()
      const res = await fetch(`/api/admin/staff/${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role }),
      })
      if (!res.ok) throw new Error('Failed')
      setStaff((prev) => prev.map((s) => (s.user_id === userId ? { ...s, role } : s)))
      toast({ title: `Role updated to ${role}` })
    } catch {
      toast({ title: 'Failed to update role', variant: 'destructive' })
    } finally {
      setUpdating(null)
    }
  }

  const removeStaff = async (userId: string, name: string) => {
    if (!confirm(`Remove ${name} from your restaurant?`)) return
    setUpdating(userId)
    try {
      const token = await getAccessToken()
      const res = await fetch(`/api/admin/staff/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
      setStaff((prev) => prev.filter((s) => s.user_id !== userId))
      toast({ title: `${name} removed` })
    } catch {
      toast({ title: 'Failed to remove staff', variant: 'destructive' })
    } finally {
      setUpdating(null)
    }
  }

  if (loading) return <div className="p-8">Loading...</div>

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Staff</h1>
        <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          Invite Staff
        </Button>
      </div>

      <InviteStaffDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInviteSent={handleInviteSent}
      />

      <div className="border rounded-lg divide-y">
        {staff.length === 0 && (
          <p className="p-6 text-gray-500 text-sm text-center">
            No staff members yet. Invite someone to get started.
          </p>
        )}
        {staff.map((member) => {
          const name = member.users?.name || member.users?.email || 'Unknown'
          const email = member.users?.email || ''
          const isOwner = member.role === 'owner'
          return (
            <div key={member.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium text-sm">{name}</p>
                <p className="text-xs text-gray-500">{email}</p>
                {!member.invite_accepted && (
                  <p className="text-xs text-amber-500 mt-0.5">Invite pending</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                {isOwner ? (
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-full ${ROLE_COLORS.owner}`}
                  >
                    Owner
                  </span>
                ) : (
                  <Select
                    value={member.role}
                    onValueChange={(val) => changeRole(member.user_id, val)}
                    disabled={updating === member.user_id}
                  >
                    <SelectTrigger className="w-32 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {assignableRoles.map((role) => (
                        <SelectItem
                          key={role.role_slug}
                          value={role.role_slug}
                          className="text-xs capitalize"
                        >
                          {role.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!isOwner && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-gray-400 hover:text-red-500"
                    onClick={() => removeStaff(member.user_id, name)}
                    disabled={updating === member.user_id}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-6">
        <PendingInvitesList
          invites={invites}
          onCancelInvite={handleCancelInvite}
          cancellingId={cancellingInviteId}
        />
      </div>
    </div>
  )
}
