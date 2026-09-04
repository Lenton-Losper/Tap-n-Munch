/**
 * FlashTap Permission System
 *
 * Canonical permission definitions live in code (server-side).
 * Role assignments live in the database (restaurant_users).
 * Per-user overrides live in the database (staff_permissions).
 *
 * The client never participates in authorization decisions.
 */

import { ROLE_PERMISSIONS_BY_ROLE } from './role-permissions-config'

export const PERMISSIONS = {
  // Orders
  ORDERS_READ:    'orders:read',
  ORDERS_UPDATE:  'orders:update',
  ORDERS_DELETE:  'orders:delete',
  ORDERS_STATION_KITCHEN: 'orders:station:kitchen',
  ORDERS_STATION_BAR: 'orders:station:bar',

  // Menu
  MENU_READ:      'menu:read',
  MENU_WRITE:     'menu:write',

  // Tables
  TABLES_READ:    'tables:read',
  TABLES_MANAGE:  'tables:manage',

  /**
   * Closing a tab that still owes money — a walkout.
   *
   * SEPARATE FROM tables:manage, DELIBERATELY. `tables:manage` is arranging the floor, and WAITERS
   * hold it because they legitimately need it. Gating a walkout on it would let the person being
   * walked out on sign off the loss, which is the one party who should not be able to.
   *
   * Manager and owner only. Not cashier: taking payment and writing off a debt are different
   * authorities, and the second is the one that needs a second pair of eyes.
   */
  TABS_CLOSE_UNPAID: 'tabs:close_unpaid',

  // Payments
  PAYMENTS_PROCESS: 'payments:process',
  PAYMENTS_VIEW: 'payments:view',
  PAYMENTS_CONFIGURE: 'payments:configure',
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_REFUND: 'payments:refund',

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

  // Stock transfers (location-internal: create/dispatch at the source, receive at the destination)
  STOCK_TRANSFER_CREATE:   'stock:transfer_create',
  STOCK_TRANSFER_DISPATCH: 'stock:transfer_dispatch',
  STOCK_TRANSFER_RECEIVE:  'stock:transfer_receive',

  // Recipes
  RECIPE_VIEW: 'recipe:view',
  RECIPE_EDIT: 'recipe:edit',

  // Analytics
  ANALYTICS_VIEW: 'analytics:view',

  // Business documents (quotes / invoices)
  DOCUMENTS_READ: 'documents:read',
  DOCUMENTS_WRITE: 'documents:write',

  // Terminal authorization
  TERMINAL_AUTH_MANAGE: 'terminal:auth:manage',
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

/**
 * Static fallback permissions per role (role-permissions.config.json).
 * Primary source is restaurant_roles in the DB (Authorization v2 Phase 2).
 * authorize() falls back here when no restaurant_roles row exists.
 * Per-user exceptions are stored in staff_permissions and applied on top.
 */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = ROLE_PERMISSIONS_BY_ROLE as Record<
  string,
  Permission[]
>
