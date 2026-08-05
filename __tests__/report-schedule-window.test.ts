/**
 * Daily report scheduling window.
 *
 * Guards the three defects measured in production on 2026-08-05:
 *  - send_time and timezone were stored, editable in Settings, and ignored by the cron.
 *    Riviera's schedule read 20:50 Africa/Windhoek; its sends landed 20:04-20:55 UTC.
 *  - the report covered YESTERDAY, computed in UTC, not the trading day closing.
 *  - a skipped tick lost the day permanently. Periods 2026-07-23 and 2026-07-29 are simply
 *    absent from report_send_log, with no failure recorded anywhere.
 */
import {
  decideDue,
  detectMissedDay,
  dueAtUtc,
  localDate,
  normaliseSendTime,
  type ScheduleRow,
} from '@/lib/reports/schedule-window'

const MINGLE: ScheduleRow = {
  id: 'sched-1',
  restaurant_id: 'rest-1',
  email: 'celestinemouton@hotmail.com',
  format: 'csv',
  enabled: true,
  send_time: '19:00:00',
  timezone: 'Africa/Windhoek',
  created_at: '2026-08-01T00:00:00.000Z',
}

const none = new Set<string>()

describe('timezone handling — Namibia is UTC+2 year round, no DST', () => {
  it('resolves 19:00 Windhoek to 17:00 UTC in August', () => {
    expect(dueAtUtc('2026-08-05', '19:00:00', 'Africa/Windhoek').toISOString())
      .toBe('2026-08-05T17:00:00.000Z')
  })

  it('resolves the same in January — no DST shift', () => {
    expect(dueAtUtc('2026-01-15', '19:00:00', 'Africa/Windhoek').toISOString())
      .toBe('2026-01-15T17:00:00.000Z')
  })

  it('derives the local calendar day, not the UTC one', () => {
    // 22:30 UTC on the 5th is already 00:30 on the 6th in Windhoek.
    expect(localDate(new Date('2026-08-05T22:30:00Z'), 'Africa/Windhoek')).toBe('2026-08-06')
    expect(localDate(new Date('2026-08-05T12:00:00Z'), 'Africa/Windhoek')).toBe('2026-08-05')
  })

  it('normalises the stored time format', () => {
    expect(normaliseSendTime('19:00')).toBe('19:00:00')
    expect(normaliseSendTime('19:00:00')).toBe('19:00:00')
    expect(normaliseSendTime('19:00:00.000')).toBe('19:00:00')
    expect(normaliseSendTime(null)).toBe('20:00:00')
  })
})

describe('decideDue — honours send_time instead of firing whenever the cron runs', () => {
  it('does not send before the local send time', () => {
    // 16:59 UTC = 18:59 Windhoek.
    const d = decideDue({ schedule: MINGLE, now: new Date('2026-08-05T16:59:00Z'), sentPeriods: none })
    expect(d.due).toBe(false)
    expect(d).toMatchObject({ reason: 'before_send_time' })
  })

  it('sends once the local send time is reached', () => {
    const d = decideDue({ schedule: MINGLE, now: new Date('2026-08-05T17:00:00Z'), sentPeriods: none })
    expect(d.due).toBe(true)
  })

  it('reports the trading day that is CLOSING, not yesterday', () => {
    const d = decideDue({ schedule: MINGLE, now: new Date('2026-08-05T17:00:00Z'), sentPeriods: none })
    expect(d.reportPeriod).toBe('2026-08-05')
  })

  it('does not resend once that day is already logged', () => {
    const d = decideDue({
      schedule: MINGLE,
      now: new Date('2026-08-05T17:30:00Z'),
      sentPeriods: new Set(['2026-08-05']),
    })
    expect(d.due).toBe(false)
    expect(d).toMatchObject({ reason: 'already_sent' })
  })

  it('stays idle across every 2-minute tick after sending', () => {
    const sentPeriods = new Set(['2026-08-05'])
    for (let m = 0; m < 60; m += 2) {
      const now = new Date(`2026-08-05T${String(17 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`)
      expect(decideDue({ schedule: MINGLE, now, sentPeriods }).due).toBe(false)
    }
  })

  it('skips a disabled schedule', () => {
    const d = decideDue({
      schedule: { ...MINGLE, enabled: false },
      now: new Date('2026-08-05T18:00:00Z'),
      sentPeriods: none,
    })
    expect(d).toMatchObject({ due: false, reason: 'disabled' })
  })

  it('catches up on a later tick when the send time was missed', () => {
    // Nothing ran at 17:00; the 21:00 UTC tick must still send that same trading day.
    const d = decideDue({ schedule: MINGLE, now: new Date('2026-08-05T21:00:00Z'), sentPeriods: none })
    expect(d).toMatchObject({ due: true, reportPeriod: '2026-08-05' })
  })

  it('rolls to the new trading day after local midnight', () => {
    // 22:30 UTC = 00:30 on the 6th locally, which is before that day's 19:00 send time.
    const d = decideDue({ schedule: MINGLE, now: new Date('2026-08-05T22:30:00Z'), sentPeriods: new Set(['2026-08-05']) })
    expect(d).toMatchObject({ due: false, reason: 'before_send_time', reportPeriod: '2026-08-06' })
  })

  it('gives each restaurant its own time from its own row', () => {
    const early = { ...MINGLE, id: 's2', send_time: '15:00:00' }
    const now = new Date('2026-08-05T13:30:00Z') // 15:30 Windhoek
    expect(decideDue({ schedule: early, now, sentPeriods: none }).due).toBe(true)
    expect(decideDue({ schedule: MINGLE, now, sentPeriods: none }).due).toBe(false)
  })
})

describe('detectMissedDay — a skipped day leaves no row, so absence must be detected', () => {
  it('flags the previous day when nothing was logged and its window has passed', () => {
    const r = detectMissedDay({
      schedule: MINGLE,
      now: new Date('2026-08-05T17:00:00Z'),
      sentPeriods: new Set(['2026-08-03']),
    })
    expect(r).toEqual({ missed: true, period: '2026-08-04' })
  })

  it('does not flag a day that was sent', () => {
    const r = detectMissedDay({
      schedule: MINGLE,
      now: new Date('2026-08-05T17:00:00Z'),
      sentPeriods: new Set(['2026-08-04']),
    })
    expect(r).toEqual({ missed: false })
  })

  it('does not blame a schedule for a day that predates it', () => {
    const fresh = { ...MINGLE, created_at: '2026-08-05T09:00:00.000Z' }
    expect(detectMissedDay({ schedule: fresh, now: new Date('2026-08-05T17:00:00Z'), sentPeriods: none }))
      .toEqual({ missed: false })
  })

  it('only ever looks one day back, so a dormant schedule cannot emit a burst', () => {
    const r = detectMissedDay({
      schedule: MINGLE,
      now: new Date('2026-08-05T17:00:00Z'),
      sentPeriods: none,
    })
    expect(r).toEqual({ missed: true, period: '2026-08-04' })
  })
})
