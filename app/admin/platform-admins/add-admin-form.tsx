'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getAccessToken } from '@/lib/onboarding/api-client'

export function AddPlatformAdminForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'support' | 'super_admin'>('support')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
      setError('Enter an email address')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/platform/admins', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email: trimmed, role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add platform admin')
      }
      setEmail('')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add platform admin')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-2">
          <label htmlFor="admin-email" className="text-sm text-[#6B675F]">
            Email
          </label>
          <Input
            id="admin-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@example.com"
            disabled={submitting}
            className="rounded-lg border-[#E9E9E7]"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="admin-role" className="text-sm text-[#6B675F]">
            Role
          </label>
          <Select value={role} onValueChange={(v) => setRole(v as 'support' | 'super_admin')}>
            <SelectTrigger id="admin-role" className="w-full rounded-lg border-[#E9E9E7] sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="support">Support</SelectItem>
              <SelectItem value="super_admin">Super Admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
        >
          {submitting ? 'Adding...' : 'Add platform admin'}
        </Button>
      </div>
      <p className="text-xs text-[#9B978E]">
        The account must already exist (they need to have signed up) — this adds them as a
        platform admin immediately, no separate invite/accept step for now.
      </p>
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
