/**
 * FlashTap Permission System
 *
 * Canonical permission definitions live in code (server-side).
 * Role assignments live in the database (restaurant_users).
 * Per-user overrides live in the database (staff_permissions).
 *
 * The client never participates in authorization decisions.
 */

import rolePermissionsConfig from './role-permissions.config.json'

export const PERMISSIONS = {
  // Orders
  ORDERS_READ:    'orders:read',
  ORDERS_UPDATE:  'orders:update',
  ORDERS_DELETE:  'orders:delete',

  // Menu
  MENU_READ:      'menu:read',
  MENU_WRITE:     'menu:write',

  // Tables
  TABLES_READ:    'tables:read',
  TABLES_MANAGE:  'tables:manage',

  // Payments
  PAYMENTS_PROCESS: 'payments:process',

  // Staff
  STAFF_MANAGE:   'staff:manage',

  // Settings
  SETTINGS_READ:  'settings:read',
  SETTINGS_WRITE: 'settings:write',

  // Stock
  STOCK_VIEW:       'stock:view',
  STOCK_RECEIVE:    'stock:receive',
  STOCK_ADJUST:     'stock:adjust',
  STOCK_VIEW_COSTS: 'stock:view_costs',
  STOCK_DELETE_GRV: 'stock:delete_grv',

  // Recipes
  RECIPE_VIEW: 'recipe:view',
  RECIPE_EDIT: 'recipe:edit',
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

/**
 * Default permissions per role.
 * These are application-level defaults — they live in code, not the DB.
 * Per-user exceptions are stored in staff_permissions and applied on top.
 *
 * Role → capability mapping is defined in role-permissions.config.json.
 */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = Object.fromEntries(
  Object.entries(rolePermissionsConfig).filter(([key]) => !key.startsWith('$')),
) as Record<string, Permission[]>
