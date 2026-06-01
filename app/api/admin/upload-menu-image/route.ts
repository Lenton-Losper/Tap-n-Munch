import { NextResponse } from 'next/server'
import { getPublicStorageUrl, uploadImageServer } from '@/lib/supabase/storage-server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const restaurantId = String(formData.get('restaurantId') || '').trim()
    const itemId = String(formData.get('itemId') || '').trim()

    if (!restaurantId) {
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

    const timestamp = Date.now()
    const randomString = Math.random().toString(36).slice(2, 10)
    const ext = file.name.split('.').pop() || 'jpg'
    const path = itemId
      ? `menu-items/${restaurantId}/${itemId}-${timestamp}.${ext}`
      : `menu-items/${restaurantId}/${timestamp}-${randomString}.${ext}`

    const buffer = await file.arrayBuffer()
    const storagePath = await uploadImageServer(buffer, path, file.type)
    const url = getPublicStorageUrl(storagePath)
    return NextResponse.json({ success: true, url })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload image'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
