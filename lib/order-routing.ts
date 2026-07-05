export type OrderRouteTo = 'kitchen' | 'bar' | 'both'

export type StaffStation = 'kitchen' | 'bar'

const VALID_ROUTE_TO = new Set<OrderRouteTo>(['kitchen', 'bar', 'both'])

export function normalizeRouteTo(value: unknown): OrderRouteTo {
  const normalized = String(value || 'kitchen').trim().toLowerCase()
  if (VALID_ROUTE_TO.has(normalized as OrderRouteTo)) {
    return normalized as OrderRouteTo
  }
  return 'kitchen'
}

export function orderMatchesStation(
  order: { items?: unknown },
  station: StaffStation
): boolean {
  const items = Array.isArray(order.items) ? order.items : []
  if (items.length === 0) {
    return station === 'kitchen'
  }

  return items.some((item) => {
    const route = normalizeRouteTo((item as { route_to?: unknown })?.route_to)
    if (station === 'kitchen') {
      return route === 'kitchen' || route === 'both'
    }
    return route === 'bar' || route === 'both'
  })
}

export type StationScopeOptions = {
  hasKitchenStation: boolean
  hasBarStation: boolean
}

export function shouldFilterByStationScope(options: StationScopeOptions): boolean {
  return options.hasKitchenStation || options.hasBarStation
}

export function orderVisibleForStationScope(
  order: { items?: unknown },
  options: StationScopeOptions
): boolean {
  const { hasKitchenStation, hasBarStation } = options
  if (!shouldFilterByStationScope(options)) {
    return true
  }
  return (
    (hasKitchenStation && orderMatchesStation(order, 'kitchen')) ||
    (hasBarStation && orderMatchesStation(order, 'bar'))
  )
}

export function filterOrdersByStationScope<T extends { items?: unknown }>(
  orders: T[],
  options: StationScopeOptions
): T[] {
  if (!shouldFilterByStationScope(options)) {
    return orders
  }
  return orders.filter((order) => orderVisibleForStationScope(order, options))
}

export async function enrichOrderItemsWithRouteTo(
  supabase: { from: (table: string) => any },
  items: unknown
): Promise<unknown[]> {
  if (!Array.isArray(items) || items.length === 0) {
    return Array.isArray(items) ? items : []
  }

  const menuItemIds = [
    ...new Set(
      items
        .map((item) => {
          const row = item as { menuItemId?: string; menu_item_id?: string }
          return String(row.menuItemId || row.menu_item_id || '').trim()
        })
        .filter(Boolean)
    ),
  ]

  if (menuItemIds.length === 0) {
    return items.map((item) => ({ ...(item as object), route_to: 'kitchen' }))
  }

  const { data: menuItems, error: menuItemsError } = await supabase
    .from('menu_items')
    .select('id, category_id')
    .in('id', menuItemIds)

  if (menuItemsError) {
    console.error('[ORDERS] failed to load menu items for route_to', menuItemsError)
    return items.map((item) => ({ ...(item as object), route_to: 'kitchen' }))
  }

  const categoryIds = [
    ...new Set(
      (menuItems || [])
        .map((row: { category_id?: string | null }) => String(row.category_id || '').trim())
        .filter(Boolean)
    ),
  ]

  const routeByCategoryId: Record<string, OrderRouteTo> = {}
  if (categoryIds.length > 0) {
    const { data: categories, error: categoriesError } = await supabase
      .from('menu_categories')
      .select('id, route_to')
      .in('id', categoryIds)

    if (categoriesError) {
      console.error('[ORDERS] failed to load menu categories for route_to', categoriesError)
    } else {
      for (const category of categories || []) {
        routeByCategoryId[String(category.id)] = normalizeRouteTo(category.route_to)
      }
    }
  }

  const routeByMenuItemId: Record<string, OrderRouteTo> = {}
  for (const menuItem of menuItems || []) {
    const categoryId = String(menuItem.category_id || '').trim()
    routeByMenuItemId[String(menuItem.id)] = routeByCategoryId[categoryId] || 'kitchen'
  }

  return items.map((item) => {
    const row = item as { menuItemId?: string; menu_item_id?: string }
    const menuItemId = String(row.menuItemId || row.menu_item_id || '').trim()
    return {
      ...(item as object),
      route_to: routeByMenuItemId[menuItemId] || 'kitchen',
    }
  })
}
