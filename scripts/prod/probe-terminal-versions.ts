/**
 * THE PRODUCTION APK SPREAD. READ ONLY.
 *
 * `success: false` for the uncertain outcome is already live, and devices in the field were written
 * against the old contract where that case answered `success: true`. This says how many devices are
 * on which build, so the terminal rollout is planned against the real fleet rather than staging's.
 *
 * Staging, for comparison: 19 terminals, 1.31 -> 1.88, seven on 1.34, two reporting no version.
 * #868 happened on 1.89.
 */
import { guard, all } from './_guard'

const ONLINE_WINDOW_MS = 15 * 60 * 1000

async function main() {
  const { db } = guard([
    'Reads restaurant_terminals and restaurants. Writes nothing.',
    'Reports the app_version spread, how recently each device was seen, and which',
    'venues the oldest builds are at.',
  ])

  const terminals = await all<{
    id: string
    restaurant_id: string | null
    terminal_name: string | null
    sn: string | null
    app_version: string | null
    status: string | null
    active: boolean | null
    last_seen_at: string | null
  }>((f, t) =>
    db
      .from('restaurant_terminals')
      .select('id, restaurant_id, terminal_name, sn, app_version, status, active, last_seen_at')
      .range(f, t),
  )

  const rests = await all<{ id: string; name: string }>((f, t) => db.from('restaurants').select('id, name').range(f, t))
  const nameOf = new Map(rests.map((r) => [String(r.id), String(r.name)]))

  const now = Date.now()
  const seenMs = (t: { last_seen_at: string | null }) =>
    t.last_seen_at ? now - new Date(t.last_seen_at).getTime() : Infinity

  console.log(`production terminals: ${terminals.length}`)

  // Version spread. A device that has not checked in for months is not part of the rollout problem,
  // so the count is split rather than lumped -- an "online" total is the number that matters.
  const byVersion = new Map<string, { total: number; online: number }>()
  for (const t of terminals) {
    const v = String(t.app_version ?? '(none reported)')
    if (!byVersion.has(v)) byVersion.set(v, { total: 0, online: 0 })
    const e = byVersion.get(v)!
    e.total++
    if (seenMs(t) < ONLINE_WINDOW_MS) e.online++
  }

  const cmp = (a: string, b: string) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    if (Number.isNaN(pa[0]) || Number.isNaN(pb[0])) return a.localeCompare(b)
    return (pb[0] - pa[0]) || ((pb[1] ?? 0) - (pa[1] ?? 0))
  }

  console.log('')
  console.log('  version        total   seen in the last 15 min')
  for (const [v, e] of [...byVersion.entries()].sort(([a], [b]) => cmp(a, b))) {
    console.log('  ' + v.padEnd(16) + String(e.total).padStart(3) + '     ' + String(e.online).padStart(3))
  }

  const online = terminals.filter((t) => seenMs(t) < ONLINE_WINDOW_MS)
  console.log('')
  console.log(`  online now: ${online.length} of ${terminals.length}`)
  console.log(`  never seen: ${terminals.filter((t) => !t.last_seen_at).length}`)
  console.log(`  no version reported: ${terminals.filter((t) => !t.app_version).length}`)

  // The devices that matter: recently active AND on an old build.
  console.log('')
  console.log('='.repeat(78))
  console.log('ACTIVE IN THE LAST 7 DAYS, OLDEST BUILD FIRST — these are the rollout')
  console.log('='.repeat(78))
  const recent = terminals
    .filter((t) => seenMs(t) < 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => cmp(String(b.app_version ?? '0'), String(a.app_version ?? '0')))
  for (const t of recent) {
    const mins = Math.round(seenMs(t) / 60000)
    console.log(
      '  ' +
        String(t.app_version ?? '(none)').padEnd(10) +
        String(nameOf.get(String(t.restaurant_id)) ?? t.restaurant_id ?? '?').slice(0, 30).padEnd(32) +
        String(t.terminal_name ?? t.sn ?? t.id).slice(0, 22).padEnd(24) +
        `seen ${mins}m ago`,
    )
  }
  if (recent.length === 0) console.log('  none active in the last 7 days')

  console.log('')
  console.log('PROBE_TERMINAL_VERSIONS_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
