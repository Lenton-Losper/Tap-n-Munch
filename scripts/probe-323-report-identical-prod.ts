/**
 * #323 -- FNB CHOWNOW, JULY 2026, BEFORE AND AFTER.
 *
 * 695 orders: under the 1000-row cap, so pagination must change NOTHING. Byte-identical output is
 * the only acceptable result -- a report that shifts on a month that never truncated would mean the
 * change did something other than what it claims.
 *
 * READ-ONLY against production. getReportData issues SELECTs and nothing else.
 *
 * Run twice, once per implementation, and diff:
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-323-report-identical-prod.ts > after.json
 */
import { readFileSync } from 'fs'

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

const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'

async function main() {
  const { getReportData } = await import('../lib/reports/get-report-data')
  const report = await getReportData({
    restaurantId: FNB_CHOWNOW,
    startDate: '2026-07-01',
    endDate: '2026-07-31',
  })

  // `generatedAt` is a timestamp and differs between runs by design -- excluding it is the only
  // way the comparison can mean anything. Everything else must match exactly.
  const stable = { ...(report as unknown as Record<string, unknown>) }
  delete stable.generatedAt

  process.stdout.write(JSON.stringify(stable, null, 2))
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
