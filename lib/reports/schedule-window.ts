import { wallTimeInTimeZoneToUtc, DEFAULT_REPORT_TIMEZONE } from '@/lib/reports/format-report-datetime'

/**
 * When a daily report schedule is due, in the restaurant's own timezone.
 *
 * Replaces the previous rule ("enabled AND last_sent_at older than 23h"), which ignored
 * `send_time` and `timezone` entirely even though both are stored and editable in Settings.
 * Measured consequence: Riviera's schedule reads 20:50 Africa/Windhoek and its sends landed
 * at 20:04-20:55 UTC -- 2 to 4 hours late, driven purely by when the cron happened to fire.
 *
 * Two further things the old rule got wrong, both fixed here:
 *  - It reported YESTERDAY (`new Date(); setDate(-1)`, in UTC), so a 19:00 send would deliver
 *    the previous day. The period is now the trading day that is CLOSING.
 *  - A skipped tick lost the day permanently, because 23h-since-last-send has no concept of
 *    which day was missed. Keying on report_period lets a later tick catch up.
 */

export type ScheduleRow = {
  id: string
  restaurant_id: string
  email: string
  format: string
  enabled: boolean
  send_time: string | null
  timezone: string | null
  created_at?: string | null
}

/** `YYYY-MM-DD` for an instant, in the given IANA zone. */
export function localDate(now: Date, timeZone: string): string {
  const tz = (timeZone || '').trim() || DEFAULT_REPORT_TIMEZONE
  // en-CA gives ISO-ordered YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Normalises `19:00`, `19:00:00`, `19:00:00.000` to `HH:mm:ss`. */
export function normaliseSendTime(sendTime: string | null | undefined): string {
  const raw = String(sendTime ?? '').trim()
  if (!raw) return '20:00:00'
  const [h = '0', m = '0', s = '0'] = raw.split(':')
  const pad = (v: string) => String(Math.max(0, Math.min(59, Number(v) || 0))).padStart(2, '0')
  const hh = String(Math.max(0, Math.min(23, Number(h) || 0))).padStart(2, '0')
  return `${hh}:${pad(m)}:${pad(s.split('.')[0])}`
}

/** The UTC instant at which `localDay` reaches `send_time` in the schedule's zone. */
export function dueAtUtc(localDay: string, sendTime: string, timeZone: string): Date {
  const tz = (timeZone || '').trim() || DEFAULT_REPORT_TIMEZONE
  return wallTimeInTimeZoneToUtc(localDay, normaliseSendTime(sendTime), tz)
}

export type DueDecision =
  | { due: true; reportPeriod: string; dueAt: string }
  | { due: false; reason: 'disabled' | 'before_send_time' | 'already_sent'; reportPeriod: string; dueAt: string }

/**
 * Should this schedule send right now?
 *
 * Due when: enabled, local now has reached `send_time` for the local day, and no SUCCESSFUL
 * send is already recorded for that local day. `sentPeriods` is the set of report_period
 * values already logged as success for this schedule -- keying on it, rather than on elapsed
 * time, is what makes a missed tick catch up instead of silently losing the day.
 */
export function decideDue(params: {
  schedule: ScheduleRow
  now: Date
  sentPeriods: ReadonlySet<string>
}): DueDecision {
  const { schedule, now, sentPeriods } = params
  const tz = (schedule.timezone || '').trim() || DEFAULT_REPORT_TIMEZONE
  const reportPeriod = localDate(now, tz)
  const dueAt = dueAtUtc(reportPeriod, schedule.send_time ?? '20:00:00', tz)
  const dueAtIso = dueAt.toISOString()

  if (!schedule.enabled) {
    return { due: false, reason: 'disabled', reportPeriod, dueAt: dueAtIso }
  }
  if (now.getTime() < dueAt.getTime()) {
    return { due: false, reason: 'before_send_time', reportPeriod, dueAt: dueAtIso }
  }
  if (sentPeriods.has(reportPeriod)) {
    return { due: false, reason: 'already_sent', reportPeriod, dueAt: dueAtIso }
  }
  return { due: true, reportPeriod, dueAt: dueAtIso }
}

/**
 * The previous local day, if its send window has fully passed and nothing was logged for it.
 *
 * A skipped day used to be invisible: absence of a row was the only evidence, and nothing
 * looked for it. Production shows exactly this -- periods 2026-07-23 and 2026-07-29 are simply
 * missing from report_send_log, 2 of 17 days, with no failure recorded anywhere.
 *
 * Only ever looks one day back, so a long-dormant schedule cannot emit a burst of alerts, and
 * only counts a day as missed if the schedule already existed when that day's window passed.
 */
export function detectMissedDay(params: {
  schedule: ScheduleRow
  now: Date
  sentPeriods: ReadonlySet<string>
}): { missed: true; period: string } | { missed: false } {
  const { schedule, now, sentPeriods } = params
  const tz = (schedule.timezone || '').trim() || DEFAULT_REPORT_TIMEZONE
  const today = localDate(now, tz)
  const [y, m, d] = today.split('-').map(Number)
  const prev = new Date(Date.UTC(y, m - 1, d - 1))
  const period = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`

  if (sentPeriods.has(period)) return { missed: false }

  const prevDue = dueAtUtc(period, schedule.send_time ?? '20:00:00', tz)
  if (now.getTime() < prevDue.getTime()) return { missed: false }

  // Do not blame a schedule for a day that predates it.
  if (schedule.created_at) {
    const created = new Date(schedule.created_at)
    if (!Number.isNaN(created.getTime()) && created.getTime() > prevDue.getTime()) {
      return { missed: false }
    }
  }
  return { missed: true, period }
}
