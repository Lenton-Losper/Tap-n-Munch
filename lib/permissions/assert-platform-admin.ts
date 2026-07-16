import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { NextResponse } from 'next/server'

export async function assertPlatformAdmin(request: Request): Promise<NextResponse | null> {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const { data: isAdmin, error } = await supabase.rpc('is_platform_admin', {
      p_user_id: user.id,
    })
    if (error) throw error
    if (!isAdmin) {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 })
    }
    return null
  } catch {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
}
