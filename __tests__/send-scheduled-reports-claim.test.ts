/**
 * send-scheduled-reports: a report is emailed AT MOST ONCE per (schedule, trading day), even when
 * two invocations run at the same time.
 *
 * WHY THIS EXISTS. The route decided "already sent?" by reading report_send_log and then sending.
 * Two invocations running together both read "not sent" and both send. On 2026-10-04, 21:46 to at
 * least 22:54 UTC, Cloudflare dispatched every production cron tick TWICE, 3 s apart, so this was
 * one send window away from emailing nine venues twice.
 *
 * THE DOUBLE ENFORCES THE DATABASE'S RULE, not the route's. It stores report_send_log rows and
 * refuses (23505) a second row for the same (schedule_id, report_period) while one is `claimed` or
 * `success` -- exactly the unique partial index in migration 20261005120000. So a route that does
 * not claim before it sends is caught here the same way production would fail to stop it: the
 * email has already gone by the time anything conflicts.
 */
type Row = Record<string, unknown>

const SCHEDULE = {
  id: 'sched-1',
  restaurant_id: 'rest-1',
  email: 'owner@example.test',
  format: 'csv',
  enabled: true,
  send_time: '19:00:00',
  timezone: 'Africa/Windhoek',
  created_at: '2026-08-01T00:00:00.000Z',
}
const PERIOD = '2026-10-04'
const LIVE = new Set(['claimed', 'success'])

const db: { sendLog: Row[]; audits: Row[]; failInsert?: Row | null; failClaimRelease?: boolean } = {
  sendLog: [],
  audits: [],
}
let nextId = 1
const tick = () => new Promise((r) => setTimeout(r, 5))

function conflicts(row: Row, exceptId?: unknown) {
  return (
    LIVE.has(String(row.status)) &&
    db.sendLog.some(
      (r) =>
        r.id !== exceptId &&
        r.schedule_id === row.schedule_id &&
        r.report_period === row.report_period &&
        LIVE.has(String(r.status)),
    )
  )
}

function makeClient() {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      let op: 'select' | 'insert' | 'update' = 'select'
      let payload: Row = {}
      const chain: Record<string, unknown> = {}
      const self = () => chain

      const run = async (): Promise<{ data: unknown; error: unknown }> => {
        await tick()
        if (table === 'report_schedules') {
          if (op === 'update') return { data: null, error: null }
          return { data: [SCHEDULE], error: null }
        }
        if (table === 'audit_logs') {
          if (op === 'insert') db.audits.push(payload)
          return { data: [], error: null }
        }
        // report_send_log
        if (op === 'insert') {
          if (db.failInsert && db.failInsert.status === payload.status) {
            return { data: null, error: { code: 'XX000', message: 'insert failed (fixture)' } }
          }
          if (conflicts(payload)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "report_send_log_one_claim_per_period"' } }
          }
          const row = { id: `log-${nextId++}`, sent_at: new Date().toISOString(), ...payload }
          db.sendLog.push(row)
          return { data: { id: row.id }, error: null }
        }
        const hit = db.sendLog.filter((r) => eqs.every(([c, v]) => r[c] === v))
        if (op === 'update') {
          if (db.failClaimRelease && payload.status === 'failed') {
            return { data: null, error: { code: 'XX000', message: 'release failed (fixture)' } }
          }
          for (const r of hit) {
            const next = { ...r, ...payload }
            if (conflicts(next, r.id)) return { data: null, error: { code: '23505', message: 'duplicate' } }
            Object.assign(r, payload)
          }
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        return { data: hit.map((r) => ({ ...r })), error: null }
      }

      chain.select = () => self()
      chain.insert = (row: Row) => {
        op = 'insert'
        payload = row
        return self()
      }
      chain.update = (patch: Row) => {
        op = 'update'
        payload = patch
        return self()
      }
      chain.eq = (c: string, v: unknown) => {
        eqs.push([c, v])
        return self()
      }
      for (const m of ['order', 'limit', 'contains']) chain[m] = () => self()
      chain.single = () => run()
      chain.maybeSingle = () => run()
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej)
      return chain
    },
  }
}

const send = jest.fn(async () => {
  await tick()
  return { id: 'email-1' }
})

jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => makeClient() }))
jest.mock('@/lib/api/require-cron-secret', () => ({ requireCronSecret: () => null }))
jest.mock('@/lib/reports/get-report-data', () => ({ getReportData: async () => ({}) }))
jest.mock('@/lib/reports/generate-csv', () => ({ generateCsv: () => 'a,b\n1,2' }))
jest.mock('@/lib/reports/generate-pdf-lib', () => ({ generatePdfBlob: async () => new Blob(['pdf']) }))
jest.mock('@/lib/reports/daily-report-email', () => ({
  buildDailyReportHtml: () => '<p>report</p>',
  buildDailyReportSubject: () => 'Daily report',
}))
jest.mock('@/lib/email/resend', () => ({ getResend: () => ({ emails: { send } }) }))
// Due unless a SUCCESS row exists for the period -- the real rule's essential shape (sentPeriods).
jest.mock('@/lib/reports/schedule-window', () => ({
  decideDue: ({ sentPeriods }: { sentPeriods: Set<string> }) =>
    sentPeriods.has(PERIOD)
      ? { due: false, reason: 'already_sent', reportPeriod: PERIOD, dueAt: null }
      : { due: true, reportPeriod: PERIOD },
  detectMissedDay: () => ({ missed: false }),
}))

import { POST } from '@/app/api/cron/send-scheduled-reports/route'

const invoke = async () => (await POST(new Request('https://x/api/cron/send-scheduled-reports', { method: 'POST' }))).json()

beforeEach(() => {
  db.sendLog = []
  db.audits = []
  db.failInsert = null
  db.failClaimRelease = false
  send.mockClear()
  send.mockImplementation(async () => {
    await tick()
    return { id: 'email-1' }
  })
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('send-scheduled-reports never emails a period twice', () => {
  it('two invocations at the same moment send ONE email', async () => {
    const [a, b] = await Promise.all([invoke(), invoke()])

    expect(send).toHaveBeenCalledTimes(1)
    const success = db.sendLog.filter((r) => r.status === 'success')
    expect(success).toHaveLength(1)
    // the loser says why it sent nothing
    const statuses = [...a.results, ...b.results].map((r: Row) => r.status).sort()
    expect(statuses).toEqual(['claimed_elsewhere', 'success'])
  })

  it('a later run after a successful send sends nothing more', async () => {
    await invoke()
    await invoke()
    expect(send).toHaveBeenCalledTimes(1)
    expect(db.sendLog.filter((r) => r.status === 'success')).toHaveLength(1)
  })

  it('a FAILED send releases its claim, so the next tick retries -- and sends exactly once', async () => {
    send.mockImplementationOnce(async () => {
      await tick()
      throw new Error('resend 500 (fixture)')
    })
    const first = await invoke()
    expect(first.results[0].status).toBe('failed')
    expect(db.sendLog.filter((r) => r.status === 'claimed')).toHaveLength(0)

    const second = await invoke()
    expect(second.results[0].status).toBe('success')
    expect(send).toHaveBeenCalledTimes(2) // one failed attempt, one delivered email
    expect(db.sendLog.filter((r) => r.status === 'success')).toHaveLength(1)
  })

  it('sends NOTHING when the claim itself cannot be written -- no claim, no email', async () => {
    db.failInsert = { status: 'claimed' }
    const res = await invoke()
    expect(send).not.toHaveBeenCalled()
    expect(res.results[0].status).toBe('skipped')
  })

  it('at-most-once when a failed send cannot release its claim: no retry, and it is surfaced', async () => {
    // The deliberate trade-off. A claim that could not be released stays `claimed`, so the period is
    // never re-sent automatically -- a duplicate is impossible, a missed day is detectable (the
    // missed-day alert and this audit row) and a person can resend.
    send.mockImplementationOnce(async () => {
      await tick()
      throw new Error('resend 500 (fixture)')
    })
    db.failClaimRelease = true
    await invoke()
    db.failClaimRelease = false
    await invoke()
    expect(send).toHaveBeenCalledTimes(1)
    const audit = db.audits.find((a) => (a.metadata as Row)?.claimReleaseFailed === true)
    expect(audit).toBeDefined()
  })
})
