/**
 * PHASE 1 (perf/latency-sprint, 2026-10-01): client-side latency of a worker, for A/B placement.
 *
 * Run it from where the terminals are (Namibia), once per variant, against the SAME worker:
 *
 *   node scripts/perf/measure-placement.mjs https://<staging-host> [rounds=30] > a.json
 *   ...deploy the placement variant to STAGING, wait >= 15 min of traffic for smart mode...
 *   node scripts/perf/measure-placement.mjs https://<staging-host> [rounds=30] > b.json
 *
 * Endpoints:
 *   /api/version                    no database: the client<->worker cost alone (the CONTROL --
 *                                   placement can only make this WORSE, by moving the worker away)
 *   /api/menu/<id>/features         public, no auth, exactly ONE database round trip
 *   /api/terminal/heartbeat (POST)  terminal auth + record check: 1-3 sequential DB round trips
 *   /api/terminal/orders?scope=active   the list's bounded view: ~4 sequential round trips
 *   /api/terminal/orders            the legacy list: ~25 sequential round trips at FNB scale
 * The terminal endpoints run only when STAGING_TERMINAL_TOKEN is set (a STAGING terminal's access
 * token, from the environment; it is never printed or written anywhere).
 *
 * Requests are sequential, never concurrent, so the numbers are what one terminal sees. Each
 * sample records wall time and the `cf-placement` header (`remote-XXX` = placed, `local-XXX` = not).
 * Output: JSON on stdout -- per endpoint p50/p90/min/max and the placement values seen.
 *
 * Refuses production hosts. No main-module guard on purpose (Windows file:// mismatch).
 */
const base = (process.argv[2] ?? '').replace(/\/+$/, '')
const rounds = Number(process.argv[3] ?? 30)
if (!/^https:\/\//.test(base)) {
  console.error('usage: measure-placement.mjs https://<staging-host> [rounds]')
  process.exit(2)
}
if (/flashtap\.app|riviera|production/i.test(base)) {
  console.error(`refusing: ${base} looks like production`)
  process.exit(3)
}

const token = process.env.STAGING_TERMINAL_TOKEN || null
// A STAGING restaurant for the public one-round-trip read (default: staging "Tests").
const restaurantId = process.env.PLACEMENT_RESTAURANT_ID || '8ba53a84-c498-40cc-a66d-ecc73f2537df'
const endpoints = [
  { name: 'version (no DB, control)', method: 'GET', path: '/api/version', auth: false },
  { name: 'menu features (1 DB RT)', method: 'GET', path: `/api/menu/${restaurantId}/features`, auth: false },
  { name: 'terminal heartbeat', method: 'POST', path: '/api/terminal/heartbeat', auth: true, body: '{}' },
  { name: 'orders ?scope=active', method: 'GET', path: '/api/terminal/orders?scope=active', auth: true },
  { name: 'orders (legacy list)', method: 'GET', path: '/api/terminal/orders', auth: true },
].filter((e) => !e.auth || token)

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const result = { base, rounds, at: new Date().toISOString(), terminalEndpoints: Boolean(token), endpoints: [] }
for (const e of endpoints) {
  const ms = []
  const placement = {}
  const statuses = {}
  const colos = {}
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now()
    const res = await fetch(`${base}${e.path}${e.path.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      method: e.method,
      headers: {
        'cache-control': 'no-store',
        ...(e.body ? { 'content-type': 'application/json' } : {}),
        ...(e.auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: e.body,
    })
    await res.arrayBuffer()
    ms.push(Math.round(performance.now() - t0))
    const p = res.headers.get('cf-placement') ?? '(none)'
    placement[p] = (placement[p] ?? 0) + 1
    // cf-ray ends in the colo the CLIENT entered through, e.g. 8c1f...-JNB.
    const colo = (res.headers.get('cf-ray') ?? '').split('-')[1] ?? '?'
    colos[colo] = (colos[colo] ?? 0) + 1
    statuses[res.status] = (statuses[res.status] ?? 0) + 1
  }
  result.endpoints.push({
    name: e.name,
    p50: pct(ms, 50),
    p90: pct(ms, 90),
    min: Math.min(...ms),
    max: Math.max(...ms),
    placement,
    edgeColo: colos,
    statuses,
  })
  console.error(`${e.name.padEnd(26)} p50 ${pct(ms, 50)} ms  p90 ${pct(ms, 90)} ms  placement ${JSON.stringify(placement)}  edge ${JSON.stringify(colos)}  status ${JSON.stringify(statuses)}`)
}
console.log(JSON.stringify(result, null, 2))
