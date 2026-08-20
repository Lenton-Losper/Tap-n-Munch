import { redirect } from 'next/navigation'
import { authorize } from '@/lib/permissions/authorize'
import type { Permission } from '@/lib/permissions'
import { createServerSessionClient } from '@/lib/supabase/server-session'
import { resolveSessionRestaurantId } from '@/lib/auth/resolve-session-restaurant'

export type MenuAccessContext = {
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>
  userId: string
  restaurantId: string
}

async function getAuthenticatedMenuContext(): Promise<
  MenuAccessContext | { error: string }
> {
  const supabase = await createServerSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Sign in required.' }
  }

  const restaurantId = await resolveSessionRestaurantId(supabase, user.id)
  if (!restaurantId) {
    return { error: 'Restaurant not found for this account.' }
  }

  return { supabase, userId: user.id, restaurantId }
}

export async function requireMenuPermission(
  permission: Permission,
): Promise<MenuAccessContext> {
  const context = await getAuthenticatedMenuContext()
  if ('error' in context) {
    redirect('/signin')
  }

  const allowed = await authorize(context.userId, context.restaurantId, permission)
  if (!allowed) {
    redirect('/dashboard')
  }

  return context
}

export async function requireMenuPermissionOrError(
  permission: Permission,
): Promise<MenuAccessContext | { error: string }> {
  const context = await getAuthenticatedMenuContext()
  if ('error' in context) {
    return context
  }

  const allowed = await authorize(context.userId, context.restaurantId, permission)
  if (!allowed) {
    return { error: 'You do not have permission to perform this action.' }
  }

  return context
}
