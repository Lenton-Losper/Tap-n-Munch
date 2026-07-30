import { DEFAULT_REPORT_TIMEZONE } from './format-report-datetime'

/**
 * Quick-select presets for the Order History date filter.
 *
 * Everything here works in *calendar dates* (`YYYY-MM-DD`) in the restaurant's timezone,
 * because that is what the history API consumes — see `calendarDateRangeToUtcIso`, which
 * turns an inclusive local calendar range into UTC bounds. Computing "today" from
 * `new Date().toISOString()` instead would be UTC-relative and therefore wrong for the
 * first two hours of every Windhoek day (UTC+2): at 00:30 local it still reads yesterday.
 */

export type DateRangePresetId =
  | 'today'
  | 'yesterday'
  | 'last2days'
  | 'thisWeek'
  | 'thisMonth'
  | 'thisYear'

export type DateRange = { startDate: string; endDate: string }

export const DATE_RANGE_PRESETS: ReadonlyArray<{ id: DateRangePresetId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last2days', label: 'Last 2 Days' },
  { id: 'thisWeek', label: 'This Week' },
  { id: 'thisMonth', label: 'This Month' },
  { id: 'thisYear', label: 'This Year' },
]

/** The calendar date (`YYYY-MM-DD`) that `instant` falls on in `timeZone`. */
export function calendarDateInTimeZone(
  instant: Date,
  timeZone: string = DEFAULT_REPORT_TIMEZONE,
): string {
  const tz = timeZone.trim() || DEFAULT_REPORT_TIMEZONE
  // en-CA renders as YYYY-MM-DD, so no part re-assembly is needed.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/** Split `YYYY-MM-DD` into numeric parts. Returns null when it isn't a real calendar date. */
function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim())
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null
  }
  return { y, m, d }
}

function toYmd(date: Date): string {
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Shift a calendar date by whole days. Pure calendar arithmetic — the UTC Date is only a
 * carrier for the Y/M/D triple, so no timezone or DST offset is involved.
 */
export function addCalendarDays(ymd: string, days: number): string {
  const parts = parseYmd(ymd)
  if (!parts) return ymd
  return toYmd(new Date(Date.UTC(parts.y, parts.m - 1, parts.d + days)))
}

/** Monday of the week containing `ymd`. Monday-start matches the en-GB/business week. */
function startOfWeek(ymd: string): string {
  const parts = parseYmd(ymd)
  if (!parts) return ymd
  const dow = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay() // 0=Sun..6=Sat
  return addCalendarDays(ymd, -((dow + 6) % 7))
}

/**
 * Resolve a preset to the inclusive calendar range the filter should show.
 *
 * The period presets (week/month/year) end at *today* rather than at the end of the
 * period: a report is a record of what happened, so a future end date would be noise.
 */
export function resolveDateRangePreset(
  preset: DateRangePresetId,
  options: { now?: Date; timeZone?: string } = {},
): DateRange {
  const today = calendarDateInTimeZone(
    options.now ?? new Date(),
    options.timeZone ?? DEFAULT_REPORT_TIMEZONE,
  )
  const parts = parseYmd(today)

  switch (preset) {
    case 'today':
      return { startDate: today, endDate: today }
    case 'yesterday': {
      const yesterday = addCalendarDays(today, -1)
      return { startDate: yesterday, endDate: yesterday }
    }
    case 'last2days':
      // Yesterday and today — two calendar days inclusive.
      return { startDate: addCalendarDays(today, -1), endDate: today }
    case 'thisWeek':
      return { startDate: startOfWeek(today), endDate: today }
    case 'thisMonth':
      return {
        startDate: parts ? `${today.slice(0, 7)}-01` : today,
        endDate: today,
      }
    case 'thisYear':
      return {
        startDate: parts ? `${today.slice(0, 4)}-01-01` : today,
        endDate: today,
      }
    default:
      return { startDate: today, endDate: today }
  }
}

/** True when `range` is exactly what the given preset would produce right now. */
export function matchesPreset(
  range: DateRange,
  preset: DateRangePresetId,
  options: { now?: Date; timeZone?: string } = {},
): boolean {
  const resolved = resolveDateRangePreset(preset, options)
  return resolved.startDate === range.startDate && resolved.endDate === range.endDate
}

/**
 * Why this range can't be queried, as a sentence for the operator — or null when it's fine.
 *
 * An inverted range is the important one: `calendarDateRangeToUtcIso` happily produces
 * `startIso > endIsoExclusive`, the `.gte(start).lt(end)` filter then matches nothing, and
 * the operator sees a confident "0 orders" that looks like real data.
 */
export function describeDateRangeProblem(
  startDate: string,
  endDate: string,
): string | null {
  if (!String(startDate).trim() || !String(endDate).trim()) {
    return 'Choose both a start date and an end date to see orders.'
  }
  const start = parseYmd(startDate)
  const end = parseYmd(endDate)
  if (!start || !end) {
    return 'Enter dates as YYYY-MM-DD.'
  }
  if (endDate < startDate) {
    // Lexicographic comparison is safe for zero-padded YYYY-MM-DD.
    return 'The end date is before the start date, so no orders can match. Swap the dates or pick a preset below.'
  }
  return null
}
