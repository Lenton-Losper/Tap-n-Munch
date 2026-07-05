import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
  resolveRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { menuItemImageDisplayUrl } from '@/lib/menu-item-image'
import { uploadImageServer } from '@/lib/supabase/storage-server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const formData = await request.formData()
    const file = formData.get('file')
    const restaurantIdRaw = String(formData.get('restaurantId') || '').trim()
    const itemId = String(formData.get('itemId') || '').trim()

    if (!restaurantIdRaw) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing image file' }, { status: 400 })
    }
    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: 'File must be an image' }, { status: 400 })
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image size must be less than 5MB' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const resolvedRestaurantId = await resolveRestaurantId(supabase, restaurantIdRaw)
    const restaurantCheck = await requireCallerRestaurantId(
      supabase,
      user.id,
      resolvedRestaurantId,
    )
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.MENU_WRITE)
    if (denied) return denied

    const timestamp = Date.now()
    const randomString = Math.random().toString(36).slice(2, 10)
    const ext = file.name.split('.').pop() || 'jpg'
    const path = itemId
      ? `menu-items/${restaurantId}/${itemId}-${timestamp}.${ext}`
      : `menu-items/${restaurantId}/${timestamp}-${randomString}.${ext}`

    const buffer = await file.arrayBuffer()
    const storagePath = await uploadImageServer(buffer, path, file.type)

    const displayUrl = itemId
      ? menuItemImageDisplayUrl(itemId, storagePath)
      : null

    return NextResponse.json({
      success: true,
      storagePath,
      url: displayUrl || storagePath,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload image'
    const status =
      message.includes('authorization') ||
      message.includes('session') ||
      message.includes('permission')
        ? 403
        : 500
    return NextResponse.json({ error: message }, { status })
  }
}
