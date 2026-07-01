import { NextResponse } from 'next/server'
import { createServerSessionClient } from '@/lib/supabase/server-session'
import { authorize } from '@/lib/permissions/authorize'
import type { Permission } from '@/lib/permissions'

export type StaffAuthContext = {
  userId: string
  restaurantId: string
  supabase: Awaited<ReturnType<typeof createServerSessionClient>>
}

export function isAuthError(
  result: StaffAuthContext | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse
}

export async function requireStaffPermission(
  restaurantId: string,
  permission: Permission,
): Promise<StaffAuthContext | NextResponse> {
  const trimmed = String(restaurantId || '').trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
  }

  const supabase = await createServerSessionClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const allowed = await authorize(user.id, trimmed, permission)
  if (!allowed) {
    return NextResponse.json(
      { error: 'You do not have permission to perform this action.' },
      { status: 403 },
    )
  }

  return { userId: user.id, restaurantId: trimmed, supabase }
}
