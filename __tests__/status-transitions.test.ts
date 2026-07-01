import {
  isValidStaffStatusTransition,
  STAFF_SETTABLE_STATUSES,
} from '../lib/orders/status-transitions'

describe('isValidStaffStatusTransition', () => {
  it('allows the dashboard kitchen flow', () => {
    expect(isValidStaffStatusTransition('pending', 'accepted')).toBe(true)
    expect(isValidStaffStatusTransition('ready_for_terminal', 'accepted')).toBe(true)
    expect(isValidStaffStatusTransition('accepted', 'preparing')).toBe(true)
    expect(isValidStaffStatusTransition('preparing', 'ready')).toBe(true)
    expect(isValidStaffStatusTransition('ready', 'completed')).toBe(true)
  })

  it('allows cancel from non-terminal states', () => {
    expect(isValidStaffStatusTransition('pending', 'cancelled')).toBe(true)
    expect(isValidStaffStatusTransition('accepted', 'cancelled')).toBe(true)
    expect(isValidStaffStatusTransition('ready', 'cancelled')).toBe(true)
  })

  it('rejects invalid transitions', () => {
    expect(isValidStaffStatusTransition('completed', 'pending')).toBe(false)
    expect(isValidStaffStatusTransition('completed', 'cancelled')).toBe(false)
    expect(isValidStaffStatusTransition('cancelled', 'accepted')).toBe(false)
    expect(isValidStaffStatusTransition('pending', 'completed')).toBe(false)
    expect(isValidStaffStatusTransition('ready', 'accepted')).toBe(false)
  })

  it('exposes settable statuses without ready_for_terminal as a target', () => {
    expect(STAFF_SETTABLE_STATUSES.has('accepted')).toBe(true)
    expect(STAFF_SETTABLE_STATUSES.has('ready_for_terminal')).toBe(false)
  })
})
