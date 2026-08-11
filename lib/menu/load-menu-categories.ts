/**
 * Guest menu loading for the QR browse surface.
 *
 * Extracted from app/menu/[restaurantId]/browse/page.tsx so the fan-out across categories can
 * be tested without driving the whole page, and so the "what loaded / what did not" outcome is
 * a value the caller can render rather than a console.error.
 */

export type MenuItem = Record<string, any>
export type SubCategory = Record<string, any>
export type MenuGroup = { subcategory: SubCategory; items: MenuItem[] }
export type GroupedMenu = Record<string, MenuGroup>

export type CategoryRef = { id: string; name?: string | null }

export type AllCategoriesLoad = {
  /** Every subcategory that loaded, merged across categories. */
  merged: GroupedMenu
  /** Display names of the categories whose fetch failed, in menu order. */
  failedCategoryNames: string[]
  /** How many categories were asked for. `failedCategoryNames.length === requestedCount` is a total failure. */
  requestedCount: number
}

export function categoryMenuUrl(restaurantId: string, categoryId: string): string {
  return `/api/menu/${encodeURIComponent(restaurantId)}/category/${encodeURIComponent(categoryId)}`
}

/**
 * One category's menu. Throws on a non-2xx so the caller can distinguish a failure from an
 * empty category — the API returns 500 `{error}` for a real fault and `{}` for a category that
 * genuinely has no items, and those must not collapse into the same screen.
 */
export async function fetchCategoryMenu(
  restaurantId: string,
  categoryId: string,
  fetchImpl: typeof fetch = fetch
): Promise<GroupedMenu> {
  const response = await fetchImpl(categoryMenuUrl(restaurantId, categoryId), {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`Menu API returned ${response.status}`)
  }
  return (await response.json()) as GroupedMenu
}

/**
 * Loads every category for the "All menu" view and the search index.
 *
 * Categories are indexed by their ORIGINAL position so `categoryOrder` — which the browse page
 * sorts on — does not shift when an earlier category fails.
 */
export async function loadAllMenuCategories(
  restaurantId: string,
  categories: readonly CategoryRef[],
  fetchImpl: typeof fetch = fetch
): Promise<AllCategoriesLoad> {
  // allSettled, not all: Promise.all rejects on the first failure and discards the payloads
  // that had already arrived, so one bad category used to blank the whole menu.
  const settled = await Promise.allSettled(
    categories.map((category) => fetchCategoryMenu(restaurantId, category.id, fetchImpl))
  )

  const merged: GroupedMenu = {}
  const failedCategoryNames: string[] = []

  for (let i = 0; i < categories.length; i++) {
    const outcome = settled[i]
    const categoryName = categories[i]?.name || ''

    if (outcome.status === 'rejected') {
      console.error(`[menu] category "${categoryName}" failed to load:`, outcome.reason)
      failedCategoryNames.push(categoryName)
      continue
    }

    const grouped = outcome.value

    for (const [key, entry] of Object.entries(grouped)) {
      const existing = merged[key]
      if (!existing) {
        merged[key] = {
          subcategory: {
            ...entry.subcategory,
            categoryName,
            categoryOrder: i,
          },
          items: [...(entry.items || [])],
        }
        continue
      }
      existing.items.push(...(entry.items || []))
    }
  }

  return { merged, failedCategoryNames, requestedCount: categories.length }
}
