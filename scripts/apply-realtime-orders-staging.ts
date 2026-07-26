/**
 * Apply only the realtime publication migration to staging (no unrelated migrations).
 *
 * Prefers STAGING_DATABASE_URL / DATABASE_URL when present; otherwise prints SQL
 * for the Supabase SQL editor.
 */
// @ts-nocheck
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'

const SQL_PATH = resolve(
  process.cwd(),
  'supabase/migrations/20260726110000_enable_realtime_orders_order_requests.sql',
)

async function main() {
  const sql = readFileSync(SQL_PATH, 'utf8')
  const dbUrl =
    process.env.STAGING_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    ''

  if (!dbUrl) {
    console.log('No STAGING_DATABASE_URL / DATABASE_URL — paste this in the staging SQL editor:')
    console.log('---')
    console.log(sql)
    console.log('---')
    process.exit(0)
  }

  let Client
  try {
    const require = createRequire(import.meta.url)
    ;({ Client } = require('pg'))
  } catch {
    console.log('pg package not installed — paste this in the staging SQL editor:')
    console.log('---')
    console.log(sql)
    console.log('---')
    process.exit(0)
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    await client.query(sql)
    const { rows } = await client.query(
      `SELECT tablename FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename IN ('orders', 'order_requests')
       ORDER BY tablename`,
    )
    console.log(
      'supabase_realtime tables:',
      rows.map((r) => r.tablename),
    )
    console.log('APPLY_REALTIME_ORDERS_STAGING_OK')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
