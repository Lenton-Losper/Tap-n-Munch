export const SETTINGS_BRAND_PRIMARY = '#d96a3b'
export const SETTINGS_BRAND_PRIMARY_HOVER = '#c45a30'

export const SETTINGS_TABS = [
  { id: 'profile', hash: '#profile', label: 'My profile' },
  { id: 'bank', hash: '#bank', label: 'Payment & terminals' },
  { id: 'billing', hash: '#billing', label: 'Billing' },
  { id: 'restaurant', hash: '#restaurant', label: 'Restaurant' },
  { id: 'business', hash: '#business', label: 'Business' },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

export const DEVICE_MODEL_OPTIONS = [
  'Wiseasy P5',
  'Wiseasy P8',
  'Other',
] as const
