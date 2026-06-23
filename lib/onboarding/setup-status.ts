export const WIZARD_STEP_FLAGS = [
  'profile_complete',
  'tables_configured',
  'menu_added',
  'qr_downloaded',
  'staff_added',
  'terminal_connected',
  'test_order_completed',
] as const

export const ALL_SETUP_FLAGS = [
  ...WIZARD_STEP_FLAGS,
  'first_payment_completed',
] as const

export type SetupFlag = (typeof ALL_SETUP_FLAGS)[number]

export type SetupStatus = {
  restaurant_id: string
  profile_complete: boolean
  tables_configured: boolean
  menu_added: boolean
  qr_downloaded: boolean
  staff_added: boolean
  terminal_connected: boolean
  test_order_completed: boolean
  first_payment_completed: boolean
  completion_percentage?: number
  profile_completed_at?: string | null
  tables_configured_at?: string | null
  menu_added_at?: string | null
  qr_downloaded_at?: string | null
  staff_added_at?: string | null
  terminal_connected_at?: string | null
  test_order_completed_at?: string | null
  first_payment_completed_at?: string | null
  updated_at?: string
}

export const SETUP_CHECKLIST_LABELS: { flag: SetupFlag; label: string }[] = [
  { flag: 'profile_complete', label: 'Restaurant Profile' },
  { flag: 'tables_configured', label: 'Tables Configured' },
  { flag: 'menu_added', label: 'Menu Created' },
  { flag: 'qr_downloaded', label: 'QR Codes Downloaded' },
  { flag: 'staff_added', label: 'Staff Added' },
  { flag: 'terminal_connected', label: 'Terminal Connected' },
  { flag: 'test_order_completed', label: 'Test Order Received' },
  { flag: 'first_payment_completed', label: 'First Payment Completed' },
]

export const WIZARD_STEPS = [
  { id: 1, title: 'Restaurant Profile', subtitle: 'Tell us about your venue' },
  { id: 2, title: 'Tables', subtitle: 'How many tables do you have?' },
  { id: 3, title: 'Menu', subtitle: 'Add your first menu items' },
  { id: 4, title: 'QR Codes', subtitle: 'Download codes for your tables' },
  { id: 5, title: 'Invite Staff', subtitle: 'Add managers and waiters' },
  { id: 6, title: 'Connect Terminal', subtitle: 'Link your FlashTap POS' },
  { id: 7, title: 'Test Order', subtitle: 'Place a test order from your phone' },
] as const

export function computeCompletionPercentage(
  status: Partial<Record<SetupFlag, boolean | undefined>>
): number {
  const completed = ALL_SETUP_FLAGS.filter((flag) => status[flag] === true).length
  return Math.round((completed / ALL_SETUP_FLAGS.length) * 100)
}

export function getFirstIncompleteWizardStep(status: Partial<SetupStatus>): number {
  for (let i = 0; i < WIZARD_STEP_FLAGS.length; i++) {
    if (!status[WIZARD_STEP_FLAGS[i]]) return i + 1
  }
  return WIZARD_STEP_FLAGS.length
}
