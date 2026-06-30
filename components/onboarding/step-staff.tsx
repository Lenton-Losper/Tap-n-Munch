'use client'

import { forwardRef, useImperativeHandle } from 'react'
import {
  PendingInvitesList,
  StaffInviteForm,
  useStaffInvites,
} from '@/components/staff/staff-invites'
import type { StepHandle } from './types'

type StepStaffProps = {
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepStaff = forwardRef<StepHandle, StepStaffProps>(function StepStaff(
  { onError, setSaving },
  ref
) {
  const { invites, addInvite } = useStaffInvites()

  useImperativeHandle(ref, () => ({
    save: async () => {
      setSaving(false)
      return true
    },
  }))

  return (
    <div className="space-y-6">
      <StaffInviteForm onError={onError} onSuccess={addInvite} />

      <PendingInvitesList
        invites={invites}
        emptyMessage="Invite managers or waiters now, or skip and do this later from your dashboard."
      />
    </div>
  )
})
