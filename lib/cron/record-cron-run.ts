import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * #156 — write one `cron_runs` row per completed scheduled-job run.
 *
 * WHY THIS EXISTS. A detection-only job that finds nothing writes nothing, so "it ran and all was
 * well" and "it never ran at all" are the same observation. That is the closed-vs-dead problem,
 * and this codebase has paid for it more than once: a security chain reported every attack REFUSED
 * during a total customer lockout, and the payment ledger reported zero duplicates for a month off
 * an empty table. `scanned = 0` is the value that matters most here — it says the job woke up and
 * had nothing to look at, which is neither an all-clear nor a silence.
 *
 * BEST-EFFORT, ALWAYS. Every failure is swallowed. A heartbeat that can abort the job it observes
 * has made the observation more dangerous than the blindness it replaces — the sweep's actual work
 * is reporting a money-path defect, and no bookkeeping row is worth losing that. It returns
 * whether the write landed so a caller can log the difference, and nothing more: no caller may
 * branch on it, and no job may read its own heartbeat to decide whether to work.
 */
export type CronRunRecord = {
  /** The cron route's path segment, e.g. 'card-payments-without-sale-row'. */
  job: string
  /** Rows CONSIDERED. 0 means the job ran with nothing to look at — not an all-clear. */
  scanned: number
  /** Problems found. `null` means the scan could not complete, which is distinct from 0. */
  findings: number | null
  /** Job-specific extras: a ratio, the worst offenders, an error message. */
  detail?: Record<string, unknown>
}

export async function recordCronRun(
  supabase: SupabaseClient,
  record: CronRunRecord,
): Promise<boolean> {
  try {
    /**
     * The table CHECKs `findings <= scanned`, so a miscounting job is refused rather than allowed
     * to write a heartbeat that lies about its own arithmetic. Clamping here instead would defeat
     * that: the row would land, look healthy, and hide the bug. Let the insert fail and log it.
     */
    const { error } = await supabase.from('cron_runs').insert({
      job: record.job,
      scanned: record.scanned,
      findings: record.findings,
      detail: record.detail ?? null,
    })
    if (error) {
      console.error(`[CRON-RUNS] could not record a run of ${record.job}`, error.message)
      return false
    }
    return true
  } catch (err) {
    console.error(
      `[CRON-RUNS] could not record a run of ${record.job}`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}
