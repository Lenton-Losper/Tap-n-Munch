import { PERMISSIONS, type Permission } from '@/lib/permissions'

export type PermissionLabel = {
  key: Permission
  label: string
  description: string
}

export type PermissionGroup = {
  domain: string
  permissions: PermissionLabel[]
}

const LABELS: Record<Permission, { label: string; description: string }> = {
  [PERMISSIONS.ORDERS_READ]: {
    label: 'View Orders',
    description: 'See live and historical orders on the dashboard.',
  },
  [PERMISSIONS.ORDERS_UPDATE]: {
    label: 'Update Orders',
    description: 'Change order status, items, and table assignments.',
  },
  [PERMISSIONS.ORDERS_DELETE]: {
    label: 'Delete Orders',
    description: 'Remove or void orders permanently.',
  },
  [PERMISSIONS.ORDERS_STATION_KITCHEN]: {
    label: 'Kitchen station scope',
    description: 'On the dashboard, only see orders routed to the kitchen.',
  },
  [PERMISSIONS.ORDERS_STATION_BAR]: {
    label: 'Bar station scope',
    description: 'On the dashboard, only see orders routed to the bar.',
  },
  [PERMISSIONS.MENU_READ]: {
    label: 'View Menu',
    description: 'Browse menu items and categories.',
  },
  [PERMISSIONS.MENU_WRITE]: {
    label: 'Edit Menu',
    description: 'Create, update, and remove menu items and prices.',
  },
  [PERMISSIONS.TABLES_READ]: {
    label: 'View Tables & QR',
    description: 'See table layouts and ordering channel QR codes.',
  },
  [PERMISSIONS.TABLES_MANAGE]: {
    label: 'Manage Tables & QR',
    description: 'Configure tables, QR codes, and ordering channels.',
  },
  [PERMISSIONS.PAYMENTS_PROCESS]: {
    label: 'Process Payments',
    description: 'Take card and cash payments at the terminal.',
  },
  [PERMISSIONS.PAYMENTS_VIEW]: {
    label: 'View Payment Settings',
    description: 'See payment methods and terminal configuration.',
  },
  [PERMISSIONS.PAYMENTS_CONFIGURE]: {
    label: 'Configure Payments',
    description: 'Change payment providers, terminals, and methods.',
  },
  [PERMISSIONS.STAFF_MANAGE]: {
    label: 'Manage Staff',
    description: 'Invite staff, assign roles, and manage permissions.',
  },
  [PERMISSIONS.SETTINGS_READ]: {
    label: 'View Settings',
    description: 'Open restaurant settings and setup pages.',
  },
  [PERMISSIONS.SETTINGS_WRITE]: {
    label: 'Edit Settings',
    description: 'Change restaurant profile, hours, and configuration.',
  },
  [PERMISSIONS.STOCK_VIEW]: {
    label: 'View Stock',
    description: 'See inventory levels, history, and stock reports.',
  },
  [PERMISSIONS.STOCK_RECEIVE]: {
    label: 'Receive Deliveries',
    description: 'Record new stock deliveries and update inventory.',
  },
  [PERMISSIONS.STOCK_ADJUST]: {
    label: 'Adjust Stock',
    description: 'Make manual stock corrections and write-offs.',
  },
  [PERMISSIONS.STOCK_VIEW_COSTS]: {
    label: 'View Stock Costs',
    description: 'See ingredient costs and valuation in stock views.',
  },
  [PERMISSIONS.STOCK_DELETE_GRV]: {
    label: 'Delete Goods Received',
    description: 'Remove goods-received records (GRV) from stock history.',
  },
  [PERMISSIONS.RECIPE_VIEW]: {
    label: 'View Recipes',
    description: 'See recipe cards and ingredient breakdowns.',
  },
  [PERMISSIONS.RECIPE_EDIT]: {
    label: 'Edit Recipes',
    description: 'Create and update recipes linked to menu items.',
  },
  [PERMISSIONS.ANALYTICS_VIEW]: {
    label: 'View Analytics',
    description: 'Open sales analytics, charts, and performance reports.',
  },
  [PERMISSIONS.DOCUMENTS_READ]: {
    label: 'View Documents',
    description: 'View quotes, invoices, and billing profile details.',
  },
  [PERMISSIONS.DOCUMENTS_WRITE]: {
    label: 'Create Documents',
    description: 'Issue and manage quotes and invoices.',
  },
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    domain: 'Orders',
    permissions: [
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_UPDATE,
      PERMISSIONS.ORDERS_DELETE,
      PERMISSIONS.ORDERS_STATION_KITCHEN,
      PERMISSIONS.ORDERS_STATION_BAR,
    ].map((key) => ({ key, ...LABELS[key] })),
  },
  {
    domain: 'Menu',
    permissions: [PERMISSIONS.MENU_READ, PERMISSIONS.MENU_WRITE].map((key) => ({
      key,
      ...LABELS[key],
    })),
  },
  {
    domain: 'Tables',
    permissions: [PERMISSIONS.TABLES_READ, PERMISSIONS.TABLES_MANAGE].map((key) => ({
      key,
      ...LABELS[key],
    })),
  },
  {
    domain: 'Payments',
    permissions: [
      PERMISSIONS.PAYMENTS_PROCESS,
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.PAYMENTS_CONFIGURE,
    ].map((key) => ({ key, ...LABELS[key] })),
  },
  {
    domain: 'Staff',
    permissions: [PERMISSIONS.STAFF_MANAGE].map((key) => ({ key, ...LABELS[key] })),
  },
  {
    domain: 'Settings',
    permissions: [PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_WRITE].map((key) => ({
      key,
      ...LABELS[key],
    })),
  },
  {
    domain: 'Stock',
    permissions: [
      PERMISSIONS.STOCK_VIEW,
      PERMISSIONS.STOCK_RECEIVE,
      PERMISSIONS.STOCK_ADJUST,
      PERMISSIONS.STOCK_VIEW_COSTS,
      PERMISSIONS.STOCK_DELETE_GRV,
    ].map((key) => ({ key, ...LABELS[key] })),
  },
  {
    domain: 'Recipes',
    permissions: [PERMISSIONS.RECIPE_VIEW, PERMISSIONS.RECIPE_EDIT].map((key) => ({
      key,
      ...LABELS[key],
    })),
  },
  {
    domain: 'Analytics',
    permissions: [PERMISSIONS.ANALYTICS_VIEW].map((key) => ({ key, ...LABELS[key] })),
  },
  {
    domain: 'Documents',
    permissions: [PERMISSIONS.DOCUMENTS_READ, PERMISSIONS.DOCUMENTS_WRITE].map((key) => ({
      key,
      ...LABELS[key],
    })),
  },
]

export function labelForPermission(key: Permission): PermissionLabel {
  return { key, ...LABELS[key] }
}
