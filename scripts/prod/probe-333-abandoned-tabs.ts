/**
 * #333 — THE PRODUCTION BACKLOG. READ ONLY.
 *
 * The reaper is built and proved on staging, and its guard is per tab rather than per population —
 * so this measurement does not gate it. What it gates is EXPECTATION: whether the first production
 * run closes six tabs or six hundred, and how much money is sitting on tabs it will refuse.
 *
 * Staging, for comparison: 10 open tabs, all >24h idle, 6 reaped, 4 left for staff (N$240).
 *
 * The activity signal is the same one the SQL function derives, and it has the same blind spot:
 * browsing is invisible: customer_sessions had no activity column at all after #338 dropped the
 * evidence of life is the newest of tab created / ready-to-pay / any order timestamp / any request
 * timestamp / any session issued.
 */
import { guard, all } from './_guard'

const H = 60 * 60 * 1000
const THRESHOLD_HOURS = 4

async function main() {
  const { db } = guard([
    'Reads tabs, orders, order_requests and customer_sessions. Writes nothing.',
    'Reports how many open tabs the 4h reaper would close, how many it would REFUSE',
    'because money or a review is outstanding, and what that money totals.',
  ])

  const tabs = await all<{
    id: string
    restaurant_id: string
    table_number: number | null
    status: string
    created_at: string
    ready_to_pay_at: string | null
    total: number | null
  }>((f, t) =>
    db
      .from('tabs')
      .select('id, restaurant_id, table_number, status, created_at, ready_to_pay_at, total')
      .eq('status', 'open')
      .range(f, t),
  )
  console.log(`open tabs: ${tabs.length}`)
  if (tabs.length === 0) {
    console.log('  nothing open — the first reaper run would do nothing at all')
    console.log('\nPROBE_333_OK')
    return
  }

  const tabIds = tabs.map((t) => String(t.id))
  const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

  const orders: { tab_id: string; placed_at: string | null; accepted_at: string | null; ready_at: string | null; completed_at: string | null; paid_at: string | null; payment_status: string | null; status: string | null; total: number | null }[] = []
  for (const slice of chunk(tabIds, 50)) {
    orders.push(
      ...(await all<(typeof orders)[number]>((f, t) =>
        db
          .from('orders')
          .select('tab_id, placed_at, accepted_at, ready_at, completed_at, paid_at, payment_status, status, total')
          .in('tab_id', slice)
          .range(f, t),
      )),
    )
  }

  const requests: { tab_id: string; placed_at: string | null; decided_at: string | null; status: string }[] = []
  for (const slice of chunk(tabIds, 50)) {
    requests.push(
      ...(await all<(typeof requests)[number]>((f, t) =>
        db.from('order_requests').select('tab_id, placed_at, decided_at, status').in('tab_id', slice).range(f, t),
      )),
    )
  }

  const sessions: { tab_id: string; created_at: string | null; expires_at: string | null }[] = []
  for (const slice of chunk(tabIds, 50)) {
    sessions.push(
      ...(await all<(typeof sessions)[number]>((f, t) =>
        db.from('customer_sessions').select('tab_id, created_at, expires_at').in('tab_id', slice).range(f, t),
      )),
    )
  }

  const now = Date.now()
  const ms = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0)

  let reapable = 0
  let refused = 0
  let refusedValue = 0
  let stillActive = 0
  const buckets = { '<4h': 0, '4-24h': 0, '1-7d': 0, '>7d': 0 }

  for (const tab of tabs) {
    const o = orders.filter((x) => String(x.tab_id) === String(tab.id))
    const r = requests.filter((x) => String(x.tab_id) === String(tab.id))
    const s = sessions.filter((x) => String(x.tab_id) === String(tab.id))

    const last = Math.max(
      ms(tab.created_at),
      ms(tab.ready_to_pay_at),
      ...o.flatMap((x) => [ms(x.placed_at), ms(x.accepted_at), ms(x.ready_at), ms(x.completed_at), ms(x.paid_at)]),
      ...r.flatMap((x) => [ms(x.placed_at), ms(x.decided_at)]),
      ...s.map((x) => ms(x.created_at)),
    )
    const age = now - last

    if (age < 4 * H) buckets['<4h']++
    else if (age < 24 * H) buckets['4-24h']++
    else if (age < 7 * 24 * H) buckets['1-7d']++
    else buckets['>7d']++

    if (age < THRESHOLD_HOURS * H) {
      stillActive++
      continue
    }

    const unpaid = o.filter(
      (x) =>
        String(x.payment_status ?? '').toLowerCase() !== 'paid' &&
        !['cancelled', 'canceled'].includes(String(x.status ?? '').toLowerCase()),
    )
    const awaiting = r.filter((x) => ['waiting_review', 'accepting'].includes(String(x.status)))

    if (unpaid.length > 0 || awaiting.length > 0) {
      refused++
      refusedValue += unpaid.reduce((sum, x) => sum + Number(x.total ?? 0), 0)
    } else {
      reapable++
    }
  }

  console.log('\ninactivity of open tabs:')
  for (const [k, v] of Object.entries(buckets)) console.log('  ' + k.padEnd(8) + v)

  console.log('')
  console.log('='.repeat(78))
  console.log('WHAT THE FIRST PRODUCTION RUN WOULD DO')
  console.log('='.repeat(78))
  console.log(`  reaped (nothing owed)                : ${reapable}`)
  console.log(`  REFUSED, money or review outstanding : ${refused}   (value ${refusedValue.toFixed(2)})`)
  console.log(`  untouched, active within ${THRESHOLD_HOURS}h        : ${stillActive}`)
  console.log('')
  console.log('  Each refusal writes a tab.abandoned_needs_attention audit row, so the refused set')
  console.log('  becomes a staff worklist rather than staying invisible.')

    // #338: the last_seen_at check that used to sit here is GONE with the column. It measured
    // whether last_seen_at ever differed from created_at; the settled answer was NEVER, on staging
    // and on production, and the column has been dropped. Nothing here re-derives it.

  console.log('\nPROBE_333_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
