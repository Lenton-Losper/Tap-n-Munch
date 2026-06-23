import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()

    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, full_name, phone')
      .eq('id', user.id)
      .maybeSingle()

    if (error) throw error

    const fullName = String(data?.full_name || data?.name || '').trim()
    const parts = fullName.split(/\s+/).filter(Boolean)

    return NextResponse.json({
      profile: {
        email: String(data?.email || user.email || ''),
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' '),
        phone: String(data?.phone || ''),
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load profile'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const firstName = String(body?.firstName || '').trim()
    const lastName = String(body?.lastName || '').trim()
    const phone = String(body?.phone || '').trim()
    const fullName = [firstName, lastName].filter(Boolean).join(' ')

    if (!firstName) {
      return NextResponse.json({ error: 'First name is required' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const updates: Record<string, unknown> = {
      name: fullName,
      full_name: fullName,
      phone: phone || null,
      last_login: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', user.id)
      .select('id, email, name, full_name, phone')
      .single()

    if (error) throw error

    const savedName = String(data?.full_name || data?.name || '').trim()
    const parts = savedName.split(/\s+/).filter(Boolean)

    return NextResponse.json({
      success: true,
      profile: {
        email: String(data?.email || user.email || ''),
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' '),
        phone: String(data?.phone || ''),
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save profile'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
