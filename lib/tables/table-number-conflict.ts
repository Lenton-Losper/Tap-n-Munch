/**
 * Table-number collision reporting (#175), shared by the pre-check and the unique-index
 * violation path (#174) so the two can never drift into saying different things about the
 * same conflict.
 *
 * The rule itself is unchanged: a deactivated table KEEPS its number. Freeing it would make
 * that row impossible to reactivate, and — because deactivation removes the QR from the
 * dashboard but not the printed card from the physical table — reissuing the number silently
 * routes those customers somewhere else. Orders resolve by `table_number` too, so reuse merges
 * two physical tables in history.
 *
 * What was wrong was never the rule, it was the silence: the merchant saw "Table 1 already
 * exists" with no Table 1 on screen, because inactive tables are hidden by default and the
 * card never rendered the number at all.
 */

export const UNIQUE_VIOLATION = '23505'

/** The index added in 20260806000000; a violation of it is a table-number collision. */
export const TABLE_NUMBER_UNIQUE_INDEX = 'restaurant_tables_restaurant_id_table_number_key'

export type TableNumberConflictRow = {
  table_number?: number | string | null
  table_name?: string | null
  active?: boolean | null
}

/** True when a PostgREST/Postgres error is a violation of the table-number unique index. */
export function isTableNumberUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; message?: unknown; details?: unknown }
  if (String(e.code ?? '') !== UNIQUE_VIOLATION) return false
  // A 23505 from some other index on this table is not a table-number collision, and must not
  // be reported as one. Fall back to true only when we cannot tell which index fired.
  const haystack = `${String(e.message ?? '')} ${String(e.details ?? '')}`
  if (!haystack.trim()) return true
  return haystack.includes(TABLE_NUMBER_UNIQUE_INDEX) || haystack.includes('table_number')
}

function displayNameFor(row: TableNumberConflictRow | null | undefined): string | null {
  const name = String(row?.table_name ?? '').trim()
  return name || null
}

/**
 * The message a merchant sees when a table number is taken.
 *
 * Active and deactivated conflicts need DIFFERENT actions from the merchant — pick another
 * number, versus reactivate the table you already have — so they must not share wording.
 */
export function tableNumberConflictMessage(
  tableNumber: number,
  row?: TableNumberConflictRow | null,
): string {
  const name = displayNameFor(row)

  // No row in hand. Reached when the unique index fires on a row we did not pre-read (the
  // concurrent-insert race). Still better than a 500, but deliberately does not guess at state.
  if (!row) {
    return `Table number ${tableNumber} is already used by another table.`
  }

  if (row.active === false) {
    return name
      ? `Table number ${tableNumber} is used by a deactivated table (${name}). Reactivate it instead of creating a new one.`
      : `Table number ${tableNumber} is used by a deactivated table. Reactivate it instead of creating a new one.`
  }

  return name
    ? `Table number ${tableNumber} is already used by ${name}.`
    : `Table number ${tableNumber} is already in use.`
}
