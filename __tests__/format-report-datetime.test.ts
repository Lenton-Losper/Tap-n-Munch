import {
  calendarDateRangeToUtcIso,
  formatReportDateTime,
  wallTimeInTimeZoneToUtc,
} from '../lib/reports/format-report-datetime'

describe('format-report-datetime', () => {
  it('formats UTC instants in Africa/Windhoek (+2), matching dashboard local times', () => {
    // Order #390 from 23 Jul: Finatic/UI ~15:19 Windhoek = 13:19 UTC
    const formatted = formatReportDateTime('2026-07-23T13:19:50.000Z', 'Africa/Windhoek')
    expect(formatted).toContain('23/07/2026')
    expect(formatted).toContain('15:19')
  })

  it('wallTimeInTimeZoneToUtc converts Windhoek midnight to previous-day 22:00Z', () => {
    const utc = wallTimeInTimeZoneToUtc('2026-07-23', '00:00:00.000', 'Africa/Windhoek')
    expect(utc.toISOString()).toBe('2026-07-22T22:00:00.000Z')
  })

  it('calendarDateRangeToUtcIso covers the full local calendar day', () => {
    const { startIso, endIsoExclusive } = calendarDateRangeToUtcIso(
      '2026-07-23',
      '2026-07-23',
      'Africa/Windhoek',
    )
    expect(startIso).toBe('2026-07-22T22:00:00.000Z')
    expect(endIsoExclusive).toBe('2026-07-23T22:00:00.000Z')
  })
})
