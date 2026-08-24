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

  // ---------------------------------------------------------------- what a NULL version means
  //
  // restaurant_terminals.app_version is written ONLY by the heartbeat, ONLY when the device sends
  // appVersion, and IS NEVER CLEARED. So a device that has ever reported one keeps it forever.
  //
  // That makes NULL diagnosable, and the answer is uncomfortable: a device that is heartbeating
  // NOW and still has no version has NEVER sent one, which means a build older than the field
  // itself -- the oldest software in the fleet, not an unknown modern one.
  console.log('')
  console.log('='.repeat(78))
  console.log('THE NO-VERSION DEVICES — what NULL actually means, per device')
  console.log('='.repeat(78))
  const noVersion = terminals.filter((t) => !t.app_version)
  const NEVER_ACTIVATED = noVersion.filter((t) => !t.last_seen_at)
  const LIVE_NO_VERSION = noVersion.filter((t) => t.last_seen_at && seenMs(t) < 7 * 24 * 60 * 60 * 1000)
  const STALE_NO_VERSION = noVersion.filter((t) => t.last_seen_at && seenMs(t) >= 7 * 24 * 60 * 60 * 1000)
  console.log(`  never activated (no last_seen_at at all)      : ${NEVER_ACTIVATED.length}`)
  console.log(`  HEARTBEATING but never sent a version         : ${LIVE_NO_VERSION.length}   <- a build older than the field`)
  console.log(`  last seen more than 7 days ago                : ${STALE_NO_VERSION.length}`)
  for (const t of LIVE_NO_VERSION) {
    console.log(
      '    LIVE  ' +
        String(nameOf.get(String(t.restaurant_id)) ?? t.restaurant_id ?? '?').slice(0, 28).padEnd(30) +
        String(t.terminal_name ?? t.sn ?? t.id).slice(0, 22).padEnd(24) +
        `seen ${Math.round(seenMs(t) / 60000)}m ago  status=${t.status ?? '-'}  active=${t.active}`,
    )
  }

  // ---------------------------------------------------------------- which are REALLY in service
  //
  // A row is not a terminal. Several of these have not been seen in weeks and some were never
  // activated. Deciding a rollout on the row count overstates the fleet, and deciding it on
  // 'online now' understates it -- a till is off overnight.
  console.log('')
  console.log('='.repeat(78))
  console.log('WHICH ARE REALLY IN SERVICE')
  console.log('='.repeat(78))
  const windows: [string, number][] = [
    ['seen in the last 15 min', 15 * 60 * 1000],
    ['last 24 hours', 24 * 60 * 60 * 1000],
    ['last 7 days', 7 * 24 * 60 * 60 * 1000],
    ['last 30 days', 30 * 24 * 60 * 60 * 1000],
  ]
  for (const [label, w] of windows) {
    const inWindow = terminals.filter((t) => seenMs(t) < w)
    const versions = new Set(inWindow.map((t) => String(t.app_version ?? '(none)')))
    console.log(`  ${label.padEnd(26)} ${String(inWindow.length).padStart(3)} device(s), ${versions.size} distinct version(s)`)
  }
  console.log(`  never seen at all          ${String(terminals.filter((t) => !t.last_seen_at).length).padStart(3)}`)
  console.log('')
  console.log('  THE ROLLOUT IS THE 30-DAY SET, not the row count. A till that is off tonight is')
  console.log('  still a terminal that will take a card on Monday.')

  // ---------------------------------------------------------------- dating the unknowns
  //
  // payment_events.app_version records the version AT THE TIME OF SALE, so a device with no
  // current version may still have dated itself through a sale it posted.
  const evs = await all<{ terminal_id: string | null; app_version: string | null; created_at: string }>((f, t) =>
    db.from('payment_events').select('terminal_id, app_version, created_at').range(f, t),
  )
  const everReported = new Map<string, string>()
  for (const e of evs) {
    if (e.terminal_id && e.app_version) everReported.set(String(e.terminal_id), String(e.app_version))
  }
  const datedByEvent = noVersion.filter((t) => everReported.has(String(t.id)))
  console.log('')
  console.log(`no-version devices that DID report one on a past sale: ${datedByEvent.length} of ${noVersion.length}`)
  for (const t of datedByEvent) {
    console.log(
      '    ' + String(nameOf.get(String(t.restaurant_id)) ?? '?').slice(0, 28).padEnd(30) +
        `last sale reported app ${everReported.get(String(t.id))}`,
    )
  }
  console.log('  The rest have never reported a version through ANY channel -- heartbeat or sale.')

  console.log('')
  console.log('PROBE_TERMINAL_VERSIONS_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
