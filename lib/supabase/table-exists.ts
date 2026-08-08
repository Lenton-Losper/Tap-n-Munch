/**
 * Issue #169 — table-existence probing on Supabase, and the control that proves the probe works.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 *
 * This idiom reports every ABSENT table as PRESENT:
 *
 *   const { error, count } = await db.from(t).select('*', { head: true, count: 'exact' })
 *   if (error) { /* table missing *\/ }        // never fires
 *
 * With `head: true` PostgREST answers a HEAD request; on this project a table that is not in the
 * schema cache comes back with NO error and a null count, indistinguishable from an empty table
 * that does exist. It cost a wrong report on the state of production: `invoice_requests`,
 * `order_revisions` and `refund_events` were all reported present when all three were absent,
 * which fed a claim that a migration was "partially applied" when it was essentially not applied
 * at all.
 *
 * Dropping `head` and taking a row is what surfaces the real error.
 *
 * SCOPE — READ BEFORE "FIXING" A `head: true` YOU FOUND SOMEWHERE
 *
 * `head: true` with `count: 'exact'` is the CORRECT and efficient way to COUNT ROWS, and most
 * uses in this repo are exactly that (`.eq(...)` filters, asserting on the number). Those are
 * sound and must be left alone — rewriting a payment or order count query to `.limit(1)` changes
 * what it returns. The bug is only ever in repurposing that shape as an EXISTENCE check.
 *
 * WHY THE CONTROL IS PART OF THE MODULE
 *
 * The lesson of #169 is not "use this snippet". Nothing about the wrong output looked wrong; it
 * was caught only because someone pointed the probe at a table they knew did not exist. So
 * `calibrateTableProbe` ships alongside, and callers reporting on schema state should run it
 * first. An existence probe that has only ever been pointed at things that exist has not been
 * tested — it has been confirmed.
 */

/** Minimal structural view of the client, so this works with typed and untyped clients alike. */
export type ProbeableClient = {
  from: (table: string) => {
    select: (
      columns: string,
      options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean },
    ) => {
      limit: (n: number) => PromiseLike<{
        error: { code?: string | null; message?: string | null } | null
        count?: number | null
      }>
    }
  }
}

/**
 * PostgREST reports an unknown relation as PGRST205 ("Could not find the table ... in the schema
 * cache"). 42P01 is postgres' own undefined_table, which surfaces when the statement reaches the
 * database rather than being rejected by the schema cache. Both mean absent.
 */
export const TABLE_ABSENT_CODES = ['PGRST205', '42P01'] as const

export type TableProbeResult = {
  /** True only when the probe came back clean. An error that is NOT an absence code leaves this
   *  false with `inconclusive` set — permission denied is not proof of absence. */
  exists: boolean
  /** Set when the probe failed for a reason that says nothing about existence (RLS, network). */
  inconclusive: boolean
  code: string
  message: string
  count: number | null
}

/**
 * Existence probe. Deliberately NOT `{ head: true, count: 'exact' }` — see the header.
 *
 * `count: 'exact'` is kept because the row count is useful context when the table does exist and
 * costs nothing extra; `.limit(1)` keeps the transfer to a single row. It is dropping `head`, not
 * dropping the count, that makes the absent case observable.
 */
export async function probeTable(db: ProbeableClient, table: string): Promise<TableProbeResult> {
  const { error, count } = await db.from(table).select('*', { count: 'exact' }).limit(1)
  const code = error?.code ?? 'ok'
  const message = error?.message ?? ''

  if (!error) return { exists: true, inconclusive: false, code, message, count: count ?? null }

  const absent = (TABLE_ABSENT_CODES as readonly string[]).includes(code)
  return { exists: false, inconclusive: !absent, code, message, count: null }
}

/**
 * Convenience wrapper. Throws on an inconclusive probe rather than returning false: reporting
 * "absent" because RLS refused the read is the same class of lie this module exists to stop.
 */
export async function tableExists(db: ProbeableClient, table: string): Promise<boolean> {
  const r = await probeTable(db, table)
  if (r.inconclusive) {
    throw new Error(`Inconclusive existence probe for '${table}': ${r.code} ${r.message}`)
  }
  return r.exists
}

/** A name no schema will ever contain, used as the known-absent arm of the control. */
export function absentControlName(): string {
  return `definitely_not_a_real_table_${Math.random().toString(36).slice(2, 10)}`
}

export type ProbeCalibration = {
  sound: boolean
  present: TableProbeResult
  absent: TableProbeResult
  /** Human-readable reason the calibration failed, or null when sound. */
  failure: string | null
}

/**
 * Runs the probe against a table known to exist and one known not to, and reports whether it
 * actually discriminated. Both arms must behave: a probe that says "present" for everything and
 * a probe that says "absent" for everything are equally useless, and only running both catches
 * the second.
 *
 * `presentTable` must be a table the caller is certain exists on the target database.
 */
export async function calibrateTableProbe(
  db: ProbeableClient,
  presentTable: string,
): Promise<ProbeCalibration> {
  const present = await probeTable(db, presentTable)
  const absent = await probeTable(db, absentControlName())

  let failure: string | null = null
  if (!present.exists) {
    failure = `positive control failed: '${presentTable}' probed as absent (${present.code} ${present.message})`
  } else if (absent.exists) {
    failure = 'negative control failed: a table that cannot exist probed as PRESENT — this is the #169 defect'
  } else if (absent.inconclusive) {
    failure = `negative control inconclusive: expected one of ${TABLE_ABSENT_CODES.join('/')}, got ${absent.code} ${absent.message}`
  }

  return { sound: failure === null, present, absent, failure }
}

/** Calibrate and throw unless both arms behaved. Call this before reporting on schema state. */
export async function assertTableProbeCalibrated(
  db: ProbeableClient,
  presentTable: string,
): Promise<ProbeCalibration> {
  const c = await calibrateTableProbe(db, presentTable)
  if (!c.sound) {
    throw new Error(`Table-existence probe is not sound here — refusing to report results. ${c.failure}`)
  }
  return c
}
