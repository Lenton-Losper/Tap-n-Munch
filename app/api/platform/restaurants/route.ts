import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { assertPlatformAdmin } from '@/lib/permissions/assert-platform-admin'

export const dynamic = 'force-dynamic'

async function resolveOwnerEmails(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  ownerIds: string[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ownerIds.filter(Boolean))]
  if (uniqueIds.length === 0) return new Map()

  const { data: owners } = await supabase
    .from('users')
    .select('id, email')
    .in('id', uniqueIds)

  return new Map((owners ?? []).map((owner) => [String(owner.id), String(owner.email)]))
}

export async function GET(request: Request) {
  const denied = await assertPlatformAdmin(request)
  if (denied) return denied

  try {
    const supabase = createServerSupabaseClient()

    const { data: restaurants } = await supabase
      .from('restaurants')
      .select('id, name, slug, created_at, owner_id')
      .order('created_at', { ascending: false })

    if (!restaurants) return NextResponse.json({ restaurants: [] })

    const ownerEmails = await resolveOwnerEmails(
      supabase,
      restaurants.map((r) => String(r.owner_id || ''))
    )

    const results = await Promise.all(
      restaurants.map(async (r) => {
        const [featuresRes, subRes] = await Promise.all([
          supabase
            .from('restaurant_features')
            .select('kiosk_enabled, staff_app_enabled')
            .eq('restaurant_id', r.id)
            .maybeSingle(),
          supabase
            .from('subscriptions')
            .select('plan, status')
            .eq('restaurant_id', r.id)
            .maybeSingle(),
        ])
        const ownerId = r.owner_id ? String(r.owner_id) : ''
        return {
          id: r.id,
          name: r.name,
          slug: r.slug ?? null,
          owner_email: ownerId ? ownerEmails.get(ownerId) ?? null : null,
          created_at: r.created_at,
          features: featuresRes.data,
          subscription: subRes.data,
        }
      })
    )

    return NextResponse.json({ restaurants: results })
  } catch (err) {
    console.error('[platform/restaurants] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
