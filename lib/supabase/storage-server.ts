import { restaurantLogoStoragePath } from '@/lib/restaurant-logo'
import { createServerSupabaseClient } from './server'

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'menu-images'

function assertStorageConfigured() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error('Supabase URL is not configured')
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Logo upload is not configured on the server (missing SUPABASE_SERVICE_ROLE_KEY in Vercel).'
    )
  }
}

function normalizeContentType(contentType: string): string {
  const t = String(contentType || '').toLowerCase()
  if (t === 'image/jpg') return 'image/jpeg'
  return t || 'image/png'
}

export async function uploadImageServer(
  fileBuffer: ArrayBuffer,
  path: string,
  contentType: string
): Promise<string> {
  assertStorageConfigured()
  const supabase = createServerSupabaseClient()
  const normalizedType = normalizeContentType(contentType)

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, fileBuffer, {
    upsert: true,
    contentType: normalizedType,
    cacheControl: '3600',
  })

  if (error) {
    console.error('[STORAGE] upload failed', { path, bucket: STORAGE_BUCKET, error })
    throw new Error(error.message || 'Storage upload failed')
  }

  const { error: verifyError } = await supabase.storage.from(STORAGE_BUCKET).download(path)
  if (verifyError) {
    console.error('[STORAGE] upload verify failed', { path, verifyError })
    throw new Error('Upload completed but file could not be read back from storage')
  }

  return path
}

/** Public URL (only works if the storage bucket is public). */
export function getPublicStorageUrl(path: string): string {
  const supabase = createServerSupabaseClient()
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
  const baseUrl = data.publicUrl
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
}

export async function uploadRestaurantLogoServer(
  fileBuffer: ArrayBuffer,
  restaurantId: string,
  filename: string,
  contentType: string
): Promise<string> {
  const path = restaurantLogoStoragePath(restaurantId, filename)
  return uploadImageServer(fileBuffer, path, contentType)
}
