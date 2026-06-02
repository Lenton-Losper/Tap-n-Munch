/** Storage object path, e.g. menu-items/{restaurantId}/{itemId}-123.jpg */
export function isMenuItemStoragePath(value: string | null | undefined): boolean {
  if (!value) return false
  return value.startsWith('menu-items/')
}

/** Pull object path from a legacy full Supabase public URL, if present. */
export function menuItemPathFromUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null
  if (isMenuItemStoragePath(imageUrl)) return imageUrl
  const marker = '/menu-images/'
  const idx = imageUrl.indexOf(marker)
  if (idx === -1) return null
  const rest = imageUrl.slice(idx + marker.length).split('?')[0]
  return rest || null
}

/** URL for <img src> — uses app proxy so private storage buckets work. */
export function menuItemImageDisplayUrl(
  menuItemId: string,
  imageUrl: string | null | undefined
): string | null {
  if (!imageUrl || !menuItemId) return null
  if (imageUrl.startsWith('/api/media/menu-item/')) {
    return imageUrl
  }
  if (
    isMenuItemStoragePath(imageUrl) ||
    menuItemPathFromUrl(imageUrl) ||
    imageUrl.includes('supabase.co/storage/')
  ) {
    return `/api/media/menu-item/${encodeURIComponent(menuItemId)}`
  }
  return imageUrl
}
