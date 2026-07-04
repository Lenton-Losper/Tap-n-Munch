'use client'

import { useCallback } from 'react'
import { useAuth } from '@/components/auth/auth-provider'
import type { Permission } from '@/lib/permissions'

export function usePermissions() {
  const { permissions, permissionsLoaded, loading } = useAuth()

  const hasPermission = useCallback(
    (key: Permission) => permissions.includes(key),
    [permissions],
  )

  return {
    permissions,
    permissionsLoaded,
    hasPermission,
    loading: loading || !permissionsLoaded,
  }
}
