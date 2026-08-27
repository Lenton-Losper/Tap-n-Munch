/**
 * #156 — the sweep must record that it RAN, not only that it found something.
 *
 * WHY THIS SUITE IS TWO-SIDED ON "NOTHING FOUND". The interesting assertion is not that a run with
 * findings writes a row — any implementation does that. It is that a run with `scanned: 0` writes
 * one too. Without it, "the ledger is healthy" and "the sweep is dead" produce identical evidence,
 * which is the defect the sweep itself exists to catch, one level up.
 *
 * The heartbeat is deliberately best-effort, so there is also a test that a FAILING heartbeat does
 * not fail the scan. A monitor that can take down the thing it monitors is worse than no monitor.
 */
import { recordCronRun } from '@/lib/cron/record-cron-run'

type Row = Record<string, unknown>

function makeSupabase(opts: { failWith?: string; throwWith?: string } = {}) {
  const inserted: Row[] = []
  const client = {
    from: (table: string) => {
      if (table !== 'cron_runs') throw new Error(`unexpected table ${table}`)
      return {
        insert: async (row: Row) => {
          if (opts.throwWith) throw new Error(opts.throwWith)
          inserted.push(row)
          return opts.failWith ? { error: { message: opts.failWith } } : { error: null }
        },
      }
    },
  }
  return { client, inserted }
}

describe('#156 cron_runs heartbeat', () => {
  it('records a run that found NOTHING — the case that makes silence readable', async () => {
    const { client, inserted } = makeSupabase()
    const ok = await recordCronRun(client as never, {
      job: 'card-payments-without-sale-row',
      scanned: 0,
      findings: 0,
    })

    expect(ok).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].job).toBe('card-payments-without-sale-row')
    // Explicitly 0, never null and never absent: `scanned: 0` is the fact that the job woke up.
    expect(inserted[0].scanned).toBe(0)
    expect(inserted[0].findings).toBe(0)
  })

  it('distinguishes "could not complete" from "found nothing" by writing findings: null', async () => {
    // The three states this table exists to keep apart:
    //   no row        -> never ran
    //   findings 0    -> ran, looked, all well
    //   findings null -> ran, could not finish looking
    // Collapsing the last two would report a crashing sweep as a healthy one.
    const { client, inserted } = makeSupabase()
    await recordCronRun(client as never, {
      job: 'card-payments-without-sale-row',
      scanned: 0,
      findings: null,
      detail: { error: 'boom' },
    })

    expect(inserted[0].findings).toBeNull()
    expect(inserted[0].detail).toEqual({ error: 'boom' })
  })

  it('carries the findings and the detail when there IS something', async () => {
    const { client, inserted } = makeSupabase()
    await recordCronRun(client as never, {
      job: 'card-payments-without-sale-row',
      scanned: 224,
      findings: 222,
      detail: { missingRatio: 0.99 },
    })

    expect(inserted[0].scanned).toBe(224)
    expect(inserted[0].findings).toBe(222)
  })

  it('does NOT clamp findings above scanned — the database CHECK must be allowed to refuse', async () => {
    // Clamping here would let a miscounting job write a row that looks healthy and hides the bug.
    // The constraint `findings <= scanned` is the point; this asserts we hand it the real numbers.
    const { client, inserted } = makeSupabase()
    await recordCronRun(client as never, { job: 'j', scanned: 3, findings: 5 })

    expect(inserted[0].scanned).toBe(3)
    expect(inserted[0].findings).toBe(5)
  })

  it('swallows an insert ERROR and reports false — never throws into the caller', async () => {
    const { client } = makeSupabase({ failWith: 'relation "cron_runs" does not exist' })
    await expect(
      recordCronRun(client as never, { job: 'j', scanned: 1, findings: 0 }),
    ).resolves.toBe(false)
  })

  it('swallows a THROWN error too — the client can reject, not only return an error', async () => {
    // The two failure shapes are different code paths. A supabase client that rejects (network,
    // auth) does not return `{ error }`; a suite that only covered the returned-error shape would
    // let a throw reach the sweep and abort a money-path report.
    const { client } = makeSupabase({ throwWith: 'ECONNRESET' })
    await expect(
      recordCronRun(client as never, { job: 'j', scanned: 1, findings: 0 }),
    ).resolves.toBe(false)
  })
})
