import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { menuItemPathFromUrl, isMenuItemStoragePath } from '@/lib/menu-item-image'
import { STORAGE_BUCKET } from '@/lib/supabase/storage-server'

export const dynamic = 'force-dynamic'

function contentTypeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

function resolveStoragePath(imageUrl: string): string | null {
  if (isMenuItemStoragePath(imageUrl)) return imageUrl
  return menuItemPathFromUrl(imageUrl)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const { itemId } = await params
    if (!itemId) {
      return NextResponse.json({ error: 'Missing menu item id' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const { data: item, error: itemError } = await supabase
      .from('menu_items')
      .select('image_url')
      .eq('id', itemId)
      .maybeSingle()

    if (itemError) throw itemError

    const imageUrl = item?.image_url ? String(item.image_url) : ''
    const storagePath = resolveStoragePath(imageUrl)
    if (!storagePath) {
      return NextResponse.json({ error: 'Menu item image not found' }, { status: 404 })
    }

    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(storagePath)
    if (error || !data) {
      return NextResponse.json({ error: 'Image file not found in storage' }, { status: 404 })
    }

    const buffer = await data.arrayBuffer()
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentTypeForPath(storagePath),
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
      },
    })
  } catch (error) {
    console.error('[MEDIA MENU ITEM]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load menu item image' },
      { status: 500 }
    )
  }
}
