/**
 * #169 -- calibrated schema probes for Supabase/PostgREST.
 *
 * THE INSTRUMENT THAT LIED. The obvious way to ask whether a table exists is
 *
 *     db.from(t).select('*', { head: true, count: 'exact' })
 *
 * and on this project it returns NO error and a null count for a table that does not exist.
 * Every absent table reads as present. It cost a wrong report on production: `invoice_requests`,
 * `order_revisions` and `refund_events` were all declared present when all three are absent,
 * which in turn produced the claim that `20260705210000` was "partially applied" when it is
 * essentially not applied at all.
 *
 * Selecting without `head` surfaces a real `PGRST205`, so that is the form used here.
 *
 * THE RULE THIS FILE ENCODES. An existence probe must be calibrated against a KNOWN-ABSENT
 * control before its results are trusted. A probe that has only ever been pointed at things
 * that exist has not been tested -- it has been confirmed. `calibrateSchemaProbes` makes that
 * check something you run rather than something you remember, and it is deliberately shaped so
 * a caller cannot read a result without also having read the calibration.
 *
 * WHAT THIS FILE IS NOT FOR. `{ head: true, count: 'exact' }` is perfectly correct for counting
 * rows in a table you already know exists, and the app uses it that way in ~60 places. The
 * defect is only ever using it to answer "does this exist".
 */

/** PostgREST: relation not found in the schema cache. */
export const TABLE_ABSENT_CODE = 'PGRST205'
/** Postgres: undefined_column. */
export const COLUMN_ABSENT_CODE = '42703'

/** A name no schema will ever contain. Used as the known-absent control. */
export const ABSENT_CONTROL_TABLE = 'definitely_not_a_real_table_xyz'
export const ABSENT_CONTROL_COLUMN = 'definitely_not_a_column_xyz'

export type ProbeResult = {
  present: boolean
  /**
   * Confirmed absent -- the driver returned the specific not-found code.
   *
   * THREE STATES, NOT TWO. `present: false, absent: false` is a real and important outcome: a
   * permission error, a network failure or an unrecognised code means the probe did not answer
   * the question. Collapsing that into "absent" is how an instrument starts lying again, in the
   * opposite direction from the one #169 filed.
   */
  absent: boolean
  /** `'ok'` when the probe succeeded, otherwise the driver's error code. */
  code: string
  message: string
  /** Row count when asked for and available. `null` says nothing about existence. */
  count: number | null
}

type QueryError = { code?: string | null; message?: string | null } | null

/** The minimum surface of a supabase-js client this module needs. */
export type ProbeClient = {
  from: (table: string) => {
    select: (
      columns: string,
      options?: { count?: 'exact'; head?: boolean }
    ) => {
      limit: (n: number) => PromiseLike<{ error: QueryError; count?: number | null }>
    }
  }
}

function interpret(error: QueryError, count: number | null, absentCode: string): ProbeResult {
  const code = error?.code ?? 'ok'
  return {
    present: code === 'ok',
    absent: code === absentCode,
    code,
    message: (error?.message ?? '').slice(0, 120),
    count: code === 'ok' ? (count ?? null) : null,
  }
}

/**
 * Does this table exist?
 *
 * `head` is NOT passed. That is the entire point of the function and the reason it exists as
 * shared code rather than as a comment somewhere: the correct form should be the path of least
 * resistance.
 */
export async function probeTable(db: ProbeClient, table: string): Promise<ProbeResult> {
  const { error, count } = await db.from(table).select('*', { count: 'exact' }).limit(1)
  return interpret(error, count ?? null, TABLE_ABSENT_CODE)
}

/**
 * Does this column exist? The column probe was sound all along -- an absent column raises
 * `42703` either way -- but it is here so both halves are calibrated by the same call.
 */
export async function probeColumn(
  db: ProbeClient,
  table: string,
  column: string
): Promise<ProbeResult> {
  const { error } = await db.from(table).select(column).limit(1)
  return interpret(error, null, COLUMN_ABSENT_CODE)
}

export type Calibration = {
  sound: boolean
  /** Human-readable lines, in the order they were run, for printing above any result. */
  lines: string[]
  failures: string[]
}

/**
 * Run all four controls -- present/absent x table/column -- and report whether the instrument
 * can tell the two apart HERE, against this database, right now.
 *
 * `knownTable` and `knownColumn` must be something that certainly exists on the target. If the
 * absent controls come back `present`, the probe method is not sound on this deployment and no
 * result from it means anything.
 */
export async function calibrateSchemaProbes(
  db: ProbeClient,
  knownTable: string,
  knownColumn: string
): Promise<Calibration> {
  const presentTable = await probeTable(db, knownTable)
  const absentTable = await probeTable(db, ABSENT_CONTROL_TABLE)
  const presentColumn = await probeColumn(db, knownTable, knownColumn)
  const absentColumn = await probeColumn(db, knownTable, ABSENT_CONTROL_COLUMN)

  const failures: string[] = []
  if (!presentTable.present) failures.push(`known table ${knownTable} probed ABSENT (${presentTable.code})`)
  if (absentTable.present) failures.push(`known-absent table probed PRESENT -- this is the #169 defect`)
  if (!absentTable.present && !absentTable.absent) {
    failures.push(`absent table gave ${absentTable.code}, expected ${TABLE_ABSENT_CODE}`)
  }
  if (!absentColumn.present && !absentColumn.absent) {
    failures.push(`absent column gave ${absentColumn.code}, expected ${COLUMN_ABSENT_CODE}`)
  }
  if (!presentColumn.present) {
    failures.push(`known column ${knownTable}.${knownColumn} probed ABSENT (${presentColumn.code})`)
  }
  if (absentColumn.present) failures.push('known-absent column probed PRESENT')

  return {
    sound: failures.length === 0,
    failures,
    lines: [
      `control table  PRESENT (${knownTable}): code=${presentTable.code} count=${presentTable.count}`,
      `control table  ABSENT  (fake):          code=${absentTable.code} ${absentTable.message}`,
      `control column PRESENT (${knownTable}.${knownColumn}): code=${presentColumn.code}`,
      `control column ABSENT  (fake):          code=${absentColumn.code} ${absentColumn.message}`,
    ],
  }
}
