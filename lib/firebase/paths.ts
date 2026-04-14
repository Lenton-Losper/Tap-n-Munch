/**
 * Database Path Helpers
 * 
 * Centralized path generation for hierarchical Firestore structure.
 * All paths are relative to the database root.
 */

/**
 * Get collection path for users
 */
export function usersPath(): string {
  return 'users'
}

/**
 * Get document path for a specific user
 */
export function userPath(userId: string): string {
  return `users/${userId}`
}

/**
 * Get collection path for restaurants
 */
export function restaurantsPath(): string {
  return 'restaurants'
}

/**
 * Get document path for a specific restaurant
 */
export function restaurantPath(restaurantId: string): string {
  return `restaurants/${restaurantId}`
}

/**
 * Get document path for the menu document (fixed ID: "data")
 * This document serves as a container for menu collections
 */
export function menuDocumentPath(restaurantId: string): string {
  return `restaurants/${restaurantId}/menu/data`
}

/**
 * Get collection path for menu categories under a restaurant
 * Note: menu/data is a document (4 segments, even), so categories is a collection (5 segments, odd)
 */
export function menuCategoriesPath(restaurantId: string): string {
  return `restaurants/${restaurantId}/menu/data/categories`
}

/**
 * Get document path for a specific menu category
 */
export function menuCategoryPath(restaurantId: string, categoryId: string): string {
  return `restaurants/${restaurantId}/menu/data/categories/${categoryId}`
}

/**
 * Get collection path for subcategories under a menu category
 */
export function subCategoriesPath(restaurantId: string, categoryId: string): string {
  return `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories`
}

/**
 * Get document path for a specific subcategory
 */
export function subCategoryPath(restaurantId: string, categoryId: string, subCategoryId: string): string {
  return `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}`
}

/**
 * Get collection path for menu items under a subcategory
 */
export function menuItemsPath(restaurantId: string, categoryId: string, subCategoryId: string): string {
  return `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items`
}

/**
 * Get document path for a specific menu item
 */
export function menuItemPath(restaurantId: string, categoryId: string, subCategoryId: string, itemId: string): string {
  return `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items/${itemId}`
}

/**
 * Get collection path for orders under a restaurant
 */
export function ordersPath(restaurantId: string): string {
  return `restaurants/${restaurantId}/orders`
}

/**
 * Get document path for a specific order
 */
export function orderPath(restaurantId: string, orderId: string): string {
  return `restaurants/${restaurantId}/orders/${orderId}`
}

/**
 * Get collection path for tabs under a restaurant
 */
export function tabsPath(restaurantId: string): string {
  return `restaurants/${restaurantId}/tabs`
}

/**
 * Get document path for a specific tab
 */
export function tabPath(restaurantId: string, tabId: string): string {
  return `restaurants/${restaurantId}/tabs/${tabId}`
}

/**
 * Get collection path for tables under a restaurant
 */
export function tablesPath(restaurantId: string): string {
  return `restaurants/${restaurantId}/tables`
}

/**
 * Get document path for a specific table
 */
export function tablePath(restaurantId: string, tableId: string): string {
  return `restaurants/${restaurantId}/tables/${tableId}`
}

/**
 * Get collection path for table sessions under a table
 */
export function tableSessionsPath(restaurantId: string, tableId: string): string {
  return `restaurants/${restaurantId}/tables/${tableId}/current_session`
}

/**
 * Get document path for a specific table session
 */
export function tableSessionPath(restaurantId: string, tableId: string, sessionId: string): string {
  return `restaurants/${restaurantId}/tables/${tableId}/current_session/${sessionId}`
}

/**
 * Get collection path for daily analytics under a restaurant
 */
export function analyticsDailyPath(restaurantId: string): string {
  return `restaurants/${restaurantId}/analytics/daily`
}

/**
 * Get document path for a specific daily analytics entry
 */
export function analyticsDailyEntryPath(restaurantId: string, date: string): string {
  return `restaurants/${restaurantId}/analytics/daily/${date}`
}

