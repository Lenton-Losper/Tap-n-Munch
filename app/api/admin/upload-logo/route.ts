import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getUserFromRequest,
  resolveRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { restaurantLogoDisplayUrl } from '@/lib/restaurant-logo'
import { STORAGE_BUCKET, uploadRestaurantLogoServer } from '@/lib/supabase/storage-server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  console.log('[UPLOAD LOGO] request received')

  try {
    const user = await getUserFromRequest(request)
    const formData = await request.formData()
    const file = formData.get('file')
    const restaurantIdRaw = String(formData.get('restaurantId') || '').trim()

    if (!restaurantIdRaw) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing image file' }, { status: 400 })
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Logo must be a JPG, PNG, or WebP image' },
        { status: 400 }
      )
    }

    const maxSize = 2 * 1024 * 1024
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'Logo size must be less than 2MB' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantId(supabase, restaurantIdRaw)
    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    console.log('[UPLOAD LOGO] uploading', {
      restaurantId,
      bucket: STORAGE_BUCKET,
      filename: file.name,
      size: file.size,
      type: file.type,
    })

    const buffer = await file.arrayBuffer()
    const storagePath = await uploadRestaurantLogoServer(
      buffer,
      restaurantId,
      file.name,
      file.type
    )

    const { error: updateError } = await supabase
      .from('restaurants')
      .update({ logo_url: storagePath, updated_at: new Date().toISOString() })
      .eq('id', restaurantId)

    if (updateError) {
      console.error('[UPLOAD LOGO] failed to save logo_url on restaurant', updateError)
      throw new Error(updateError.message || 'Logo uploaded but failed to save restaurant record')
    }

    const displayUrl = restaurantLogoDisplayUrl(restaurantId, storagePath)
    console.log('[UPLOAD LOGO] success', { restaurantId, storagePath, displayUrl })

    return NextResponse.json({
      success: true,
      url: displayUrl,
      storagePath,
      restaurantId,
    })
  } catch (error) {
    console.error('[UPLOAD LOGO] failed', error)
    const message = error instanceof Error ? error.message : 'Failed to upload logo'
    const status =
      message.includes('authorization') ||
      message.includes('session') ||
      message.includes('permission')
        ? 403
        : 500
    return NextResponse.json({ error: message }, { status })
  }
}
