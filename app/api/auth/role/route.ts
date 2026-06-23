import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

type StaffRole = 'owner' | 'manager' | 'waiter'

function parseStaffRole(value: unknown): StaffRole | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'owner' || normalized === 'manager' || normalized === 'waiter') {
    return normalized
  }
  return null
}

export async function GET(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()

    const { data, error } = await supabase
      .from('restaurant_users')
      .select('restaurant_id, role')
      .eq('user_id', authUser.id)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const row = data as { restaurant_id?: string; role?: string } | null

    return NextResponse.json({
      role: parseStaffRole(row?.role),
      restaurant_id: row?.restaurant_id ? String(row.restaurant_id) : null,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
