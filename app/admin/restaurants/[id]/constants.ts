export const FEATURE_FLAG_KEYS = [
  'kitchen_enabled',
  'inventory_enabled',
  'analytics_enabled',
  'split_bill_enabled',
  'reservations_enabled',
  'loyalty_enabled',
  'online_payments_enabled',
  'multi_branch_enabled',
  'staff_app_enabled',
  'kiosk_enabled',
  'whatsapp_enabled',
] as const

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number]
export type FeatureFlagsState = Record<FeatureFlagKey, boolean>
