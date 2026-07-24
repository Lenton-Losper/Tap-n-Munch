/** Default for Namibian merchants when restaurants.timezone is unset. */
export const DEFAULT_REPORT_TIMEZONE = 'Africa/Windhoek'

/**
 * Format an ISO timestamp for order-history PDF/CSV in the restaurant's IANA timezone.
 * Server runtimes (Cloudflare Workers) default to UTC — without an explicit timeZone,
 * exports show ~2h earlier than the dashboard (browser-local Africa/Windhoek).
 */
export function formatReportDateTime(
  iso: string,
  timeZone: string = DEFAULT_REPORT_TIMEZONE,
): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const tz = timeZone.trim() || DEFAULT_REPORT_TIMEZONE
  return d.toLocaleString('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function addOneCalendarDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Interpret `YYYY-MM-DDTHH:mm:ss` as a wall-clock time in `timeZone` and return the UTC Date.
 * Uses an offset probe (valid for zones without sub-hour offsets; Windhoek is UTC+2 fixed).
 */
export function wallTimeInTimeZoneToUtc(ymd: string, hms: string, timeZone: string): Date {
  const tz = timeZone.trim() || DEFAULT_REPORT_TIMEZONE
  // Initial guess: treat wall time as UTC, then correct by the zone offset at that instant.
  const guess = new Date(`${ymd}T${hms}Z`)
  const elsewhere = new Date(guess.toLocaleString('en-US', { timeZone: tz }))
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))
  const diff = asUtc.getTime() - elsewhere.getTime()
  return new Date(guess.getTime() + diff)
}

/**
 * Inclusive calendar-day range in the restaurant timezone → UTC ISO bounds for DB filters.
 * End is exclusive (start of next local day) so use `.lt(endIso)` or `.lte(endIso - 1ms)`.
 */
export function calendarDateRangeToUtcIso(
  startDate: string,
  endDate: string,
  timeZone: string = DEFAULT_REPORT_TIMEZONE,
): { startIso: string; endIsoExclusive: string } {
  const tz = timeZone.trim() || DEFAULT_REPORT_TIMEZONE
  const start = wallTimeInTimeZoneToUtc(startDate, '00:00:00.000', tz)
  const endExclusive = wallTimeInTimeZoneToUtc(addOneCalendarDay(endDate), '00:00:00.000', tz)
  return {
    startIso: start.toISOString(),
    endIsoExclusive: endExclusive.toISOString(),
  }
}
