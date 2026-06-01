/** Storage object path, e.g. restaurants/{uuid}/logo.png */
export function isLogoStoragePath(value: string | null | undefined): boolean {
  if (!value) return false
  return value.startsWith('restaurants/') && value.includes('/logo.')
}

/** Pull object path from a legacy full Supabase public URL, if present. */
export function logoPathFromUrl(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) return null
  if (isLogoStoragePath(logoUrl)) return logoUrl
  const marker = '/menu-images/'
  const idx = logoUrl.indexOf(marker)
  if (idx === -1) return null
  const rest = logoUrl.slice(idx + marker.length).split('?')[0]
  return rest || null
}

/** URL for <img src> — uses app proxy so private storage buckets work. */
export function restaurantLogoDisplayUrl(
  restaurantId: string,
  logoUrl: string | null | undefined
): string | null {
  if (!logoUrl || !restaurantId) return null
  if (logoUrl.startsWith('/api/media/restaurant-logo/')) {
    return logoUrl
  }
  if (
    isLogoStoragePath(logoUrl) ||
    logoPathFromUrl(logoUrl) ||
    logoUrl.includes('supabase.co/storage/')
  ) {
    return `/api/media/restaurant-logo/${encodeURIComponent(restaurantId)}`
  }
  return logoUrl
}

export function restaurantLogoStoragePath(
  restaurantId: string,
  filename: string
): string {
  const ext = filename.split('.').pop()?.toLowerCase() || 'png'
  const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'png'
  return `restaurants/${restaurantId}/logo.${safeExt}`
}
