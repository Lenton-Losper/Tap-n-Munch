/**
 * #323 -- PRODUCTION BEFORE/AFTER. READ-ONLY.
 *
 *   MODE=before   while flashtap.app still serves 62b3575
 *   MODE=after    once /api/version reports the new SHA
 *   MODE=compare
 *
 * Only GETs, and only against real production data. The report md5 is the load-bearing one: FNB
 * ChowNow July 2026 is 695 orders, under the 1000 cap, so pagination must change NOTHING there.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'

const MODE = process.env.MODE || 'before'
const HOST = 'https://flashtap.app'
const OUT = process.env.OUT || `i323-${MODE}.json`

const env: Record<string, string> = {}
for (const line of readFileSync(
  'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local',
  'utf8',
).split(/\r?\n/)) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2]
}
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error(`REFUSING: not production -- ${env.NEXT_PUBLIC_SUPABASE_URL}`)
}
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const OWNER_EMAIL = 'flashtaptestacc1@gmail.com'

async function token(): Promise<string> {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: OWNER_EMAIL })
  if (error || !data?.properties?.hashed_token) throw new Error(`link: ${error?.message}`)
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data: s, error: v } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'magiclink',
  })
  if (v || !s.session) throw new Error(`otp: ${v?.message}`)
  return s.session.access_token
}

async function capture() {
  const version = (await (await fetch(`${HOST}/api/version?cb=${Date.now()}`)).text()).trim()
  console.log(`${HOST} serving ${version}`)
  const out: Record<string, unknown> = { __version: version }

  // The report, in-process: this is the artefact that reaches clients.
  const { getReportData } = await import('../lib/reports/get-report-data')
  const report = await getReportData({
    restaurantId: FNB_CHOWNOW,
    startDate: '2026-07-01',
    endDate: '2026-07-31',
  })
  const stable = { ...(report as unknown as Record<string, unknown>) }
  delete stable.generatedAt
  // Pretty-printed on purpose: this must produce the SAME md5 as the staging comparison
  // (8540cd39a8473fc4aae4549f8c99823f). Compact JSON is the same data and a different digest, and
  // reporting a digest that cannot be compared to the pinned one is worse than reporting none.
  const json = JSON.stringify(stable, null, 2)
  out.reportMd5 = createHash('md5').update(json).digest('hex')
  out.reportBytes = json.length
  out.reportOrders = (stable.orders as unknown[])?.length ?? -1
  console.log(`  report: ${out.reportOrders} orders, ${out.reportBytes} bytes, md5 ${out.reportMd5}`)

  // orders-summary over HTTP -- the deployed code path.
  const t = await token()
  const res = await fetch(
    `${HOST}/api/analytics/orders-summary?restaurantId=${FNB_CHOWNOW}&cb=${Math.random()}`,
    { headers: { Authorization: `Bearer ${t}` } },
  )
  const body = await res.text()
  out.summaryStatus = res.status
  try {
    out.summaryCount = (JSON.parse(body).orders as unknown[])?.length ?? -1
  } catch {
    out.summaryCount = -1
  }
  console.log(`  orders-summary: HTTP ${out.summaryStatus}, ${out.summaryCount} orders`)

  // The true counts the converted shapes must reproduce.
  const counts: Record<string, number> = {}
  for (const [k, tweak] of [
    ['getOrders', (q: any) => q],
    ['terminalLive', (q: any) => q.in('status', ['pending', 'confirmed', 'preparing', 'ready', 'completed'])],
    ['paid', (q: any) => q.eq('payment_status', 'paid')],
  ] as const) {
    const { count } = await tweak(
      db.from('orders').select('id', { count: 'exact', head: true }).eq('restaurant_id', FNB_CHOWNOW),
    )
    counts[k] = count ?? -1
  }
  out.trueCounts = counts
  console.log(`  true counts: ${JSON.stringify(counts)}`)

  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${OUT}`)
}

function compare() {
  const b = JSON.parse(readFileSync('i323-before.json', 'utf8'))
  const a = JSON.parse(readFileSync('i323-after.json', 'utf8'))
  let fails = 0
  const ck = (l: string, p: boolean, d = '') => {
    console.log(`${p ? 'PASS' : 'FAIL'}  ${l}${d ? ` -- ${d}` : ''}`)
    if (!p) fails++
  }
  console.log(`before: ${b.__version}\nafter:  ${a.__version}\n`)
  ck('the deployed SHA changed', b.__version !== a.__version)

  console.log('\n--- FNB ChowNow July 2026 export: 695 orders, under the cap, must not move ---')
  ck('order count unchanged', b.reportOrders === a.reportOrders, `${b.reportOrders} -> ${a.reportOrders}`)
  ck('byte length unchanged', b.reportBytes === a.reportBytes, `${b.reportBytes} -> ${a.reportBytes}`)
  ck('md5 IDENTICAL', b.reportMd5 === a.reportMd5, `${a.reportMd5}`)
  ck(
    'and it is the md5 verified on staging',
    a.reportMd5 === '8540cd39a8473fc4aae4549f8c99823f',
    String(a.reportMd5),
  )

  console.log('\n--- orders-summary over HTTP ---')
  ck('status unchanged', b.summaryStatus === a.summaryStatus, `${b.summaryStatus} -> ${a.summaryStatus}`)
  ck('order count unchanged', b.summaryCount === a.summaryCount, `${b.summaryCount} -> ${a.summaryCount}`)
  ck(
    'and it equals the TRUE paid count, not a truncated one',
    a.summaryCount === a.trueCounts.paid,
    `${a.summaryCount} vs ${a.trueCounts.paid}`,
  )

  console.log('\n--- underlying counts unchanged (no data moved during the deploy) ---')
  for (const k of Object.keys(b.trueCounts)) {
    ck(k, b.trueCounts[k] === a.trueCounts[k], `${b.trueCounts[k]} -> ${a.trueCounts[k]}`)
  }

  console.log(`\n${fails === 0 ? 'PRODUCTION VERIFIED -- report identical, counts true' : `${fails} FAILED -- ROLL BACK`}`)
  process.exit(fails === 0 ? 0 : 1)
}

if (MODE === 'compare') {
  if (!existsSync('i323-before.json') || !existsSync('i323-after.json')) {
    throw new Error('need both i323-before.json and i323-after.json')
  }
  compare()
} else {
  capture().catch((e) => {
    console.error('CAPTURE FAILED:', e.message)
    process.exit(1)
  })
}
