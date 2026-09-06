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
  ORDERS_STATION_KITCHEN: 'orders:station:kitchen',
  ORDERS_STATION_BAR: 'orders:station:bar',

  /**
   * VOIDING A LINE — taking food off a bill after it was ordered.
   *
   * SEPARATE FROM orders:update, DELIBERATELY. `orders:update` is taking and amending an order,
   * which every waiter needs. Voiding is writing food off, which is the same authority shape as a
   * walkout close. Gating a void on orders:update would mean anyone who can ring a dish up can
   * make it vanish from the bill — which is precisely the control this adds.
   *
   * MANAGER AND OWNER ONLY. Not cashier, not waiter: the waiter who took the order is the one
   * with a reason to remove it, and asking them to sign off their own void is not a control.
   *
   * NOT `orders:delete`, WHICH THIS REPLACES. That one was defined, granted to 15 role rows on
   * production, and NEVER CHECKED ANYWHERE — a permission nobody enforces is a label, not a gate.
   * Its retirement is a separate commit so either change can be reverted without the other.
   */
  ORDERS_VOID: 'orders:void',

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

  /**
   * PRINTING THE END-OF-DAY CASH-UP AT THE TERMINAL.
   *
   * SEPARATE FROM analytics:view, DELIBERATELY. That one opens the dashboard's charts on a
   * browser somebody logged into. This is a P5 sitting on a bar counter all evening, and the
   * document it prints is the day's takings — what was in the drawer, split by method. Whoever
   * picks the device up should not be able to read that by tapping a tile.
   *
   * NOT tabs:close_unpaid REUSED EITHER. That is authority to write off a debt; this is authority
   * to read the day's money. They happen to land on the same two roles today, and a permission
   * that means two things stops being reviewable the moment those two things need to differ.
   *
   * MANAGER AND OWNER ONLY, and it is proved with a PIN through the `cash_up` purpose rather than
   * carried on the terminal JWT — the JWT belongs to the device, and the device is on the counter.
   */
  REPORTS_CASH_UP: 'reports:cash_up',

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
