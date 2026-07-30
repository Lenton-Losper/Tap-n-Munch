import {
  addCalendarDays,
  calendarDateInTimeZone,
  describeDateRangeProblem,
  matchesPreset,
  resolveDateRangePreset,
} from '../lib/reports/date-range-presets'
import { calendarDateRangeToUtcIso } from '../lib/reports/format-report-datetime'

const TZ = 'Africa/Windhoek'

describe('calendarDateInTimeZone', () => {
  it('uses the restaurant local day, not the UTC day', () => {
    // 22:30 UTC on 29 Jul is already 00:30 on 30 Jul in Windhoek (+2).
    const instant = new Date('2026-07-29T22:30:00.000Z')
    expect(calendarDateInTimeZone(instant, TZ)).toBe('2026-07-30')
    expect(instant.toISOString().split('T')[0]).toBe('2026-07-29') // the old, wrong answer
  })

  it('agrees with UTC during the working day', () => {
    expect(calendarDateInTimeZone(new Date('2026-07-30T13:29:23.000Z'), TZ)).toBe('2026-07-30')
  })
})

describe('addCalendarDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addCalendarDays('2024-03-01', -1)).toBe('2024-02-29') // leap year
  })
})

describe('resolveDateRangePreset', () => {
  // A Thursday, mid-afternoon Windhoek time.
  const now = new Date('2026-07-30T13:29:23.000Z')
  const at = (preset: Parameters<typeof resolveDateRangePreset>[0]) =>
    resolveDateRangePreset(preset, { now, timeZone: TZ })

  it('Today is a single day', () => {
    expect(at('today')).toEqual({ startDate: '2026-07-30', endDate: '2026-07-30' })
  })

  it('Yesterday is a single day, not a range ending today', () => {
    expect(at('yesterday')).toEqual({ startDate: '2026-07-29', endDate: '2026-07-29' })
  })

  it('Last 2 Days covers yesterday and today inclusive', () => {
    expect(at('last2days')).toEqual({ startDate: '2026-07-29', endDate: '2026-07-30' })
  })

  it('This Week starts on Monday and ends today', () => {
    // 2026-07-30 is a Thursday; that week's Monday is 2026-07-27.
    expect(new Date('2026-07-30T12:00:00Z').getUTCDay()).toBe(4)
    expect(at('thisWeek')).toEqual({ startDate: '2026-07-27', endDate: '2026-07-30' })
  })

  it('This Week on a Monday is that Monday only', () => {
    const monday = new Date('2026-07-27T12:00:00.000Z')
    expect(resolveDateRangePreset('thisWeek', { now: monday, timeZone: TZ })).toEqual({
      startDate: '2026-07-27',
      endDate: '2026-07-27',
    })
  })

  it('This Week on a Sunday still starts on the preceding Monday', () => {
    const sunday = new Date('2026-08-02T12:00:00.000Z')
    expect(new Date('2026-08-02T12:00:00Z').getUTCDay()).toBe(0)
    expect(resolveDateRangePreset('thisWeek', { now: sunday, timeZone: TZ })).toEqual({
      startDate: '2026-07-27',
      endDate: '2026-08-02',
    })
  })

  it('This Month and This Year start at the period start and end today', () => {
    expect(at('thisMonth')).toEqual({ startDate: '2026-07-01', endDate: '2026-07-30' })
    expect(at('thisYear')).toEqual({ startDate: '2026-01-01', endDate: '2026-07-30' })
  })

  it('never returns an inverted range, for any preset', () => {
    const presets = ['today', 'yesterday', 'last2days', 'thisWeek', 'thisMonth', 'thisYear'] as const
    for (const preset of presets) {
      const { startDate, endDate } = at(preset)
      expect(describeDateRangeProblem(startDate, endDate)).toBeNull()
      expect(startDate <= endDate).toBe(true)
    }
  })

  it('resolves against restaurant-local midnight, so late-evening UTC rollover is handled', () => {
    // 23:30 UTC on 30 Jul = 01:30 on 31 Jul in Windhoek. "Today" must be the 31st.
    const lateNight = new Date('2026-07-30T23:30:00.000Z')
    expect(resolveDateRangePreset('today', { now: lateNight, timeZone: TZ })).toEqual({
      startDate: '2026-07-31',
      endDate: '2026-07-31',
    })
  })
})

describe('matchesPreset', () => {
  const now = new Date('2026-07-30T13:29:23.000Z')
  it('identifies the active preset and rejects near-misses', () => {
    expect(matchesPreset({ startDate: '2026-07-30', endDate: '2026-07-30' }, 'today', { now, timeZone: TZ })).toBe(true)
    expect(matchesPreset({ startDate: '2026-07-29', endDate: '2026-07-30' }, 'today', { now, timeZone: TZ })).toBe(false)
    expect(matchesPreset({ startDate: '2026-07-29', endDate: '2026-07-30' }, 'last2days', { now, timeZone: TZ })).toBe(true)
  })
})

describe('describeDateRangeProblem', () => {
  it('accepts a valid range, including a single day', () => {
    expect(describeDateRangeProblem('2026-07-01', '2026-07-30')).toBeNull()
    expect(describeDateRangeProblem('2026-07-30', '2026-07-30')).toBeNull()
  })

  it('flags an end date before the start date', () => {
    const problem = describeDateRangeProblem('2026-07-30', '2026-07-01')
    expect(problem).toBeTruthy()
    expect(problem).toMatch(/end date is before the start date/i)
  })

  it('flags a missing date instead of silently defaulting', () => {
    expect(describeDateRangeProblem('', '2026-07-30')).toMatch(/both a start date and an end date/i)
    expect(describeDateRangeProblem('2026-07-30', '')).toMatch(/both a start date and an end date/i)
  })

  it('flags an unparseable date', () => {
    expect(describeDateRangeProblem('2026-02-30', '2026-07-30')).toMatch(/YYYY-MM-DD/)
    expect(describeDateRangeProblem('30/07/2026', '2026-07-30')).toMatch(/YYYY-MM-DD/)
  })

  it('crosses year boundaries correctly rather than comparing day-of-year', () => {
    expect(describeDateRangeProblem('2025-12-31', '2026-01-01')).toBeNull()
    expect(describeDateRangeProblem('2026-01-01', '2025-12-31')).toMatch(/end date is before/i)
  })
})

describe('the bug this guards: an inverted range silently matches nothing', () => {
  it('produces UTC bounds where start is after end, so .gte/.lt can never match', () => {
    const { startIso, endIsoExclusive } = calendarDateRangeToUtcIso('2026-07-30', '2026-07-01', TZ)
    // This is precisely why the operator saw a confident "0 orders" with no explanation.
    expect(new Date(startIso).getTime()).toBeGreaterThan(new Date(endIsoExclusive).getTime())
    // ...and why the UI must refuse the query before it is ever sent.
    expect(describeDateRangeProblem('2026-07-30', '2026-07-01')).toBeTruthy()
  })
})
