import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { NextResponse } from 'next/server'

export async function assertPlatformAdmin(request: Request): Promise<NextResponse | null> {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const { data } = await supabase
      .from('platform_admins')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!data) {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 })
    }
    return null
  } catch {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
}
