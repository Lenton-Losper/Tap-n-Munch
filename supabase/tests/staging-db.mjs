/**
 * Connect to the STAGING Postgres, with the same three-signal identity check the migration
 * applier uses. Exported so the smoke script cannot reach a different database by accident.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('file:///D:/dev/pgclient/')
const { Client } = require('pg')

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
/** Where SUPABASE_DB_PASSWORD_STAGING lives. Override with FLASHTAP_ENV_FILE. */
const ENV_FILE =
  process.env.FLASHTAP_ENV_FILE ?? 'C:/Users/223125318/Desktop/mvp2/Tap-n-Munch/.env.local'

function secret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(name + ' not found in ' + ENV_FILE)
}

export async function connectStaging() {
  const host = 'aws-1-eu-central-1.pooler.supabase.com'
  const user = 'postgres.' + STAGING_REF
  if (host.includes(PROD_REF) || user.includes(PROD_REF)) throw new Error('refusing: names production')
  const client = new Client({
    host,
    port: 5432,
    user,
    password: secret('SUPABASE_DB_PASSWORD_STAGING'),
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  })
  await client.connect()
  const venues = await client.query(
    "select count(*)::int n from public.restaurants where name = 'staging test'",
  )
  if (venues.rows[0].n < 1) {
    await client.end()
    throw new Error('ABORT: no "staging test" venue — this is not staging')
  }
  return client
}
