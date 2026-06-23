'use client'

import { useRoleGuard } from '@/hooks/use-role-guard'

export function RoleGuard({
  allowedRoles,
  children,
}: {
  allowedRoles: string[]
  children: React.ReactNode
}) {
  const { allowed, loading } = useRoleGuard(allowedRoles)

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-black mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!allowed) {
    return null
  }

  return <>{children}</>
}
