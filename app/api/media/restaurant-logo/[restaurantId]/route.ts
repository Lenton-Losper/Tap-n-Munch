import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import {
  isLogoStoragePath,
  logoPathFromUrl,
  restaurantLogoStoragePath,
} from '@/lib/restaurant-logo'
import { STORAGE_BUCKET } from '@/lib/supabase/storage-server'

export const dynamic = 'force-dynamic'

const LOGO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

function contentTypeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

async function downloadLogo(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  path: string
): Promise<{ data: Blob; path: string } | null> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(path)
  if (error || !data) return null
  return { data, path }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ restaurantId: string }> }
) {
  try {
    const { restaurantId: restaurantIdRaw } = await params
    const restaurantUuid = await resolveRestaurantUuid(restaurantIdRaw)
    const supabase = createServerSupabaseClient()

    const { data: restaurant, error: restError } = await supabase
      .from('restaurants')
      .select('logo_url')
      .eq('id', restaurantUuid)
      .maybeSingle()

    if (restError) throw restError

    const logoUrl = restaurant?.logo_url ? String(restaurant.logo_url) : ''
    const candidates: string[] = []

    if (isLogoStoragePath(logoUrl)) {
      candidates.push(logoUrl)
    } else {
      const fromUrl = logoPathFromUrl(logoUrl)
      if (fromUrl) candidates.push(fromUrl)
    }

    for (const ext of LOGO_EXTENSIONS) {
      candidates.push(restaurantLogoStoragePath(restaurantUuid, `logo.${ext}`))
    }

    const seen = new Set<string>()
    for (const path of candidates) {
      if (!path || seen.has(path)) continue
      seen.add(path)
      const result = await downloadLogo(supabase, path)
      if (!result) continue

      const buffer = await result.data.arrayBuffer()
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': contentTypeForPath(result.path),
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        },
      })
    }

    return NextResponse.json({ error: 'Logo not found' }, { status: 404 })
  } catch (error) {
    console.error('[MEDIA LOGO]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load logo' },
      { status: 500 }
    )
  }
}
