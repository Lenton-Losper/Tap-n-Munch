/**
 * Issue #175 — a table-number collision must be explainable to the merchant.
 *
 * The old message was `Table ${n} already exists`, which named a number the merchant could not
 * see (cards never rendered table_number) about a row that was hidden (inactive tables are
 * hidden by default). Worse, it read identically whether the conflicting table was in service
 * or deactivated — two situations needing completely different actions.
 */
import {
  isTableNumberUniqueViolation,
  tableNumberConflictMessage,
  TABLE_NUMBER_UNIQUE_INDEX,
} from '@/lib/tables/table-number-conflict'

describe('#175 table-number conflict message', () => {
  test('names the conflicting table when it is active', () => {
    const msg = tableNumberConflictMessage(9761, {
      table_name: 'cash-settle-1785593635133-t9761',
      active: true,
    })
    expect(msg).toContain('9761')
    expect(msg).toContain('cash-settle-1785593635133-t9761')
    expect(msg).not.toMatch(/deactivated/i)
  })

  test('says the conflicting table is DEACTIVATED, and offers reactivation as the remedy', () => {
    const msg = tableNumberConflictMessage(1, { table_name: 'Table 1', active: false })
    expect(msg).toContain('1')
    expect(msg).toContain('Table 1')
    expect(msg).toMatch(/deactivated/i)
    // The actual remedy the merchant wants — not "pick another number".
    expect(msg).toMatch(/reactivate/i)
  })

  test('active and deactivated messages differ — they need different actions', () => {
    const active = tableNumberConflictMessage(1, { table_name: 'Table 1', active: true })
    const deactivated = tableNumberConflictMessage(1, { table_name: 'Table 1', active: false })
    expect(active).not.toEqual(deactivated)
    expect(active).not.toMatch(/reactivate/i)
  })

  test('does not invent state when no row is in hand (the concurrent-insert race)', () => {
    const msg = tableNumberConflictMessage(7, null)
    expect(msg).toContain('7')
    expect(msg).not.toMatch(/deactivated/i)
    expect(msg).not.toMatch(/reactivate/i)
  })

  test('degrades without a name rather than printing "null" at the merchant', () => {
    expect(tableNumberConflictMessage(3, { table_name: null, active: true })).not.toContain('null')
    expect(tableNumberConflictMessage(3, { table_name: '   ', active: false })).not.toContain('null')
    expect(tableNumberConflictMessage(3, { table_name: null, active: false })).toMatch(/deactivated/i)
  })

  describe('unique-violation detection (#174)', () => {
    test('recognises a 23505 naming the table-number index', () => {
      expect(
        isTableNumberUniqueViolation({
          code: '23505',
          message: `duplicate key value violates unique constraint "${TABLE_NUMBER_UNIQUE_INDEX}"`,
        }),
      ).toBe(true)
    })

    test('ignores a 23505 from a DIFFERENT index on the same table', () => {
      expect(
        isTableNumberUniqueViolation({
          code: '23505',
          message: 'duplicate key value violates unique constraint "restaurant_tables_pkey"',
          details: 'Key (id)=(abc) already exists.',
        }),
      ).toBe(false)
    })

    test('ignores non-unique errors', () => {
      expect(isTableNumberUniqueViolation({ code: '23503', message: 'foreign key' })).toBe(false)
      expect(isTableNumberUniqueViolation(null)).toBe(false)
      expect(isTableNumberUniqueViolation(undefined)).toBe(false)
      expect(isTableNumberUniqueViolation('23505')).toBe(false)
    })
  })
})
