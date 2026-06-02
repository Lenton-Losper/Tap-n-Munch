import { supabase } from './client'
import { uploadImageServer, uploadRestaurantLogoServer } from './storage-server'

async function uploadImageClient(file: File, path: string): Promise<string> {
  const { error } = await supabase.storage.from('menu-images').upload(path, file, {
    upsert: true,
    contentType: file.type,
  })
  if (error) throw error

  const { data } = supabase.storage.from('menu-images').getPublicUrl(path)
  return `${data.publicUrl}${data.publicUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
}

/** Returns storage path to save on menu_items.image_url (not a broken public Supabase URL). */
export async function uploadMenuItemImage(file: File, restaurantId: string, itemId?: string): Promise<string> {
  if (typeof window !== 'undefined') {
    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      throw new Error('You must be signed in to upload images.')
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('restaurantId', restaurantId)
    if (itemId) formData.append('itemId', itemId)
    const res = await fetch('/api/admin/upload-menu-image', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || 'Failed to upload image')
    return String(data.storagePath || data.url)
  }

  const timestamp = Date.now()
  const randomString = Math.random().toString(36).slice(2, 10)
  const ext = file.name.split('.').pop() || 'jpg'
  const filename = itemId
    ? `menu-items/${restaurantId}/${itemId}-${timestamp}.${ext}`
    : `menu-items/${restaurantId}/${timestamp}-${randomString}.${ext}`
  const buffer = await file.arrayBuffer()
  return uploadImageServer(buffer, filename, file.type)
}

export async function uploadRestaurantLogo(
  file: File,
  restaurantId: string,
  accessToken: string
): Promise<string> {
  if (typeof window !== 'undefined') {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('restaurantId', restaurantId)
    const res = await fetch('/api/admin/upload-logo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || `Upload failed (${res.status})`)
    }
    if (!data?.url) {
      throw new Error('Upload succeeded but no image URL was returned')
    }
    return String(data.url)
  }

  const buffer = await file.arrayBuffer()
  return uploadRestaurantLogoServer(buffer, restaurantId, file.name, file.type)
}

// Legacy helper kept for any direct client uploads (prefer API routes in browser).
export async function uploadImage(file: File, path: string): Promise<string> {
  if (typeof window !== 'undefined') {
    return uploadImageClient(file, path)
  }
  const buffer = await file.arrayBuffer()
  return uploadImageServer(buffer, path, file.type)
}
