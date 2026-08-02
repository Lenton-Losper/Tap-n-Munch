import { getReceiptStatusBadge } from '../lib/orders/receipt-status'

describe('getReceiptStatusBadge', () => {
  it('shows PAID only when payment actually succeeded', () => {
    expect(getReceiptStatusBadge({ payment_status: 'paid', status: 'completed' }).label).toBe('PAID')
  })

  it('shows a confirming state for a QR order awaiting staff Accept', () => {
    // waiting_review means the restaurant has the order and nothing has been charged.
    // Claiming either "PAID" or "PENDING" here would be telling the customer something untrue.
    expect(getReceiptStatusBadge({ payment_status: 'waiting_review', status: 'waiting_review' }).label)
      .toBe('CONFIRMING PAYMENT…')
    expect(getReceiptStatusBadge({ status: 'waiting_review' }).label).toBe('CONFIRMING PAYMENT…')
  })

  it('shows CANCELLED for cancelled or failed payments', () => {
    expect(getReceiptStatusBadge({ payment_status: 'cancelled' }).label).toBe('CANCELLED')
    expect(getReceiptStatusBadge({ payment_status: 'failed' }).label).toBe('CANCELLED')
    expect(getReceiptStatusBadge({ status: 'cancelled' }).label).toBe('CANCELLED')
  })

  it('keeps the existing in-progress labels', () => {
    expect(getReceiptStatusBadge({ payment_status: 'pending' }).label).toBe('PENDING')
    expect(getReceiptStatusBadge({ status: 'accepted' }).label).toBe('ACCEPTED')
    expect(getReceiptStatusBadge({ status: 'ready' }).label).toBe('PREPARING')
    expect(getReceiptStatusBadge({ status: 'pending' }).label).toBe('NEW')
  })

  it('never shows a raw enum, an id, or the word unknown', () => {
    const nasty = [
      { status: 'some_future_status' },
      { status: 'waiting_for_terminal' },
      { payment_status: 'verification_uncertain' },
      {},
      { status: null, payment_status: null },
      { status: '9f3c1b20-1111-2222-3333-444455556666' },
    ]
    for (const order of nasty) {
      const { label } = getReceiptStatusBadge(order)
      expect(label).not.toMatch(/unknown/i)
      expect(label).not.toMatch(/_/) // no snake_case enum leaking through
      expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i) // no uuid
      expect(label).toBe('CONFIRMING…')
    }
  })

  it('is case-insensitive about what the database sends', () => {
    expect(getReceiptStatusBadge({ payment_status: 'PAID' }).label).toBe('PAID')
    expect(getReceiptStatusBadge({ status: 'Waiting_Review' }).label).toBe('CONFIRMING PAYMENT…')
  })

  it('always returns a non-empty label and a class', () => {
    for (const order of [{}, { status: 'paid' }, { payment_status: 'weird' }]) {
      const badge = getReceiptStatusBadge(order)
      expect(badge.label.trim().length).toBeGreaterThan(0)
      expect(badge.className.trim().length).toBeGreaterThan(0)
    }
  })
})
