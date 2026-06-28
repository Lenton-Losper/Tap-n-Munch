/**
 * FlashTap Permission System
 *
 * Canonical permission definitions live in code (server-side).
 * Role assignments live in the database (restaurant_users).
 * Per-user overrides live in the database (staff_permissions).
 *
 * The client never participates in authorization decisions.
 */

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
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

/**
 * Default permissions per role.
 * These are application-level defaults — they live in code, not the DB.
 * Per-user exceptions are stored in staff_permissions and applied on top.
 */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [
    PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_UPDATE, PERMISSIONS.ORDERS_DELETE,
    PERMISSIONS.MENU_READ, PERMISSIONS.MENU_WRITE,
    PERMISSIONS.TABLES_READ, PERMISSIONS.TABLES_MANAGE,
    PERMISSIONS.PAYMENTS_PROCESS,
    PERMISSIONS.STAFF_MANAGE,
    PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_WRITE,
  ],
  manager: [
    PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_UPDATE,
    PERMISSIONS.MENU_READ, PERMISSIONS.MENU_WRITE,
    PERMISSIONS.TABLES_READ, PERMISSIONS.TABLES_MANAGE,
    PERMISSIONS.PAYMENTS_PROCESS,
    PERMISSIONS.STAFF_MANAGE,
    PERMISSIONS.SETTINGS_READ,
  ],
  cashier: [
    PERMISSIONS.ORDERS_READ,
    PERMISSIONS.TABLES_READ,
    PERMISSIONS.PAYMENTS_PROCESS,
  ],
  waiter: [
    PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_UPDATE,
    PERMISSIONS.TABLES_READ, PERMISSIONS.TABLES_MANAGE,
  ],
  kitchen: [
    PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_UPDATE,
  ],
}
