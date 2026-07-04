import { parseStaffRole } from '@/lib/permissions/staff-role'

describe('parseStaffRole', () => {
  test('recognizes all platform staff roles including cashier and bar', () => {
    expect(parseStaffRole('owner')).toBe('owner')
    expect(parseStaffRole('Manager')).toBe('manager')
    expect(parseStaffRole('CASHIER')).toBe('cashier')
    expect(parseStaffRole('waiter')).toBe('waiter')
    expect(parseStaffRole('kitchen')).toBe('kitchen')
    expect(parseStaffRole('bar')).toBe('bar')
  })

  test('returns null for unknown roles', () => {
    expect(parseStaffRole('superuser')).toBeNull()
    expect(parseStaffRole('')).toBeNull()
    expect(parseStaffRole(null)).toBeNull()
  })
})
