'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/auth-provider'

export function useRoleGuard(allowedRoles: string[]) {
  const { role, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  const allowed = Boolean(role && allowedRoles.includes(role))

  useEffect(() => {
    if (loading || allowed) return
    if (pathname === '/dashboard') return
    router.replace('/dashboard')
  }, [loading, allowed, pathname, router])

  if (loading) {
    return { allowed: false, loading: true }
  }

  if (allowed) {
    return { allowed: true, loading: false }
  }

  return { allowed: false, loading: false }
}
