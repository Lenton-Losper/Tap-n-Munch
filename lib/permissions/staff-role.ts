export type StaffRole = 'owner' | 'manager' | 'cashier' | 'waiter' | 'kitchen' | 'bar'

export function parseStaffRole(value: unknown): StaffRole | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (
    normalized === 'owner' ||
    normalized === 'manager' ||
    normalized === 'cashier' ||
    normalized === 'waiter' ||
    normalized === 'kitchen' ||
    normalized === 'bar'
  ) {
    return normalized
  }
  return null
}
