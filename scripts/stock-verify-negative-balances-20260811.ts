/**
 * #146 — is any stock balance actually negative RIGHT NOW?
 *
 * READ-ONLY. This script issues nothing but .select(). It exists to decide whether #146 is a
 * live defect or a latent one, because that changes what the fix is worth.
 *
 * STAGING ONLY, enforced before a client is opened. Note that `.env.local` in this repo points
 * at PRODUCTION (ihlmmpmolnpchzgwyhgh) — so this script loads `.env.test` and nothing else, and
 * then refuses to continue unless the URL it got is the staging project. Both halves matter:
 * the allowlist alone would still be one stray dotenv load away from production.
 *
 *   npx tsx scripts/stock-verify-negative-balances-20260811.ts
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import path from 'node:path'

import { computeStockStatus } from '@/lib/stock/format'
import { reportNegativeStockBalances } from '@/lib/stock/report-negative-balances'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'

config({ path: path.resolve(__dirname, '..', '.env.test') })

const url = process.env.SUPABASE_URL ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

// Guard BEFORE createClient, so a wrong environment cannot open a connection at all.
if (url.includes(PRODUCTION_REF)) {
  console.error(`REFUSING: SUPABASE_URL is the PRODUCTION project (${PRODUCTION_REF}). Aborting.`)
  process.exit(1)
}
if (!url.includes(STAGING_REF)) {
  console.error(`REFUSING: SUPABASE_URL is not the staging project (${STAGING_REF}). Got: ${url || '(empty)'}`)
  process.exit(1)
}
if (!key) {
  console.error('REFUSING: SUPABASE_SERVICE_ROLE_KEY is empty.')
  process.exit(1)
}

/**
 * What the stock screen used to say about a balance, i.e. computeStockStatus WITHOUT the
 * `negative` branch. Present so the output is a two-sided comparison rather than an assertion:
 * for each live impossible balance it shows the label that hid it and the label that replaces it.
 */
function statusBeforeFix(currentStock: number, parLevel: number | null) {
  if (parLevel == null) return 'not_tracked'
  if (currentStock <= 0) return 'out_of_stock'
  if (currentStock <= parLevel) return 'low_stock'
  return 'healthy'
}

const LABELS: Record<string, string> = {
  not_tracked: 'No par level',
  out_of_stock: 'Out of Stock',
  low_stock: 'Low Stock',
  healthy: 'Healthy',
  negative: 'Impossible (negative)',
}

async function main() {
  const db = createClient(url, key, { auth: { persistSession: false } })

  // Exercises the SAME function the cron route runs, so this is a check on the shipped path
  // rather than on a re-implementation of it that could agree while both are wrong.
  const report = await reportNegativeStockBalances(db)

  console.log(`movements scanned : ${report.scanned}`)
  console.log(`NEGATIVE balances : ${report.negativeCount}`)

  if (report.negativeCount === 0) {
    console.log('\nNo negative balance on staging. #146 is latent here, not live.')
    return
  }

  for (const restaurant of report.byRestaurant) {
    console.log(`\nrestaurant ${restaurant.restaurantId}`)
    for (const row of restaurant.rows) {
      const before = statusBeforeFix(row.balance, row.parLevel)
      const after = computeStockStatus(row.balance, row.parLevel)
      console.log(
        `  ${row.name}: balance=${row.balance} par_level=${row.parLevel ?? 'null'} ` +
          `movements=${row.movementCount}`,
      )
      console.log(`    before #146: ${before} -> "${LABELS[before]}"`)
      console.log(`    after  #146: ${after} -> "${LABELS[after]}"`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
