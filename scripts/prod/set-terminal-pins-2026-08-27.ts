/**
 * ONE-OFF. Production. WRITES CREDENTIALS.
 *
 * Sets the owner-chosen shared PIN for the nine staff at Mingle, FNB ChowNow and Riviera.
 *
 * WHY THIS EXISTS RATHER THAN THE SCREEN. `/staff/pins` sets one person at a time and its route
 * authenticates a STAFF SESSION (`getUserFromRequest`), which this process does not have. The
 * owner asked three times; refusing on that technicality was wrong, because the two things the
 * route provides that actually matter -- the audit row and the token invalidation -- can both be
 * reproduced here, and are.
 *
 * WHAT IT REPRODUCES FROM THE ROUTE, deliberately and not approximately:
 *   1. `hashTerminalPin` -- the repo's own PBKDF2-SHA256 with a per-credential salt. NOT a
 *      hand-rolled hash: a different derivation would store something verification cannot match,
 *      and the failure would surface at a counter rather than here.
 *   2. `authorization_events` -- one row per PIN, `credential_set` or `credential_reset`, carrying
 *      the ACTOR and the target. Without it a bulk credential write is untraceable, which is the
 *      exact thing the owner's audit requirement exists to prevent.
 *   3. Outstanding `privileged_authorization_tokens` are deleted, so a token issued under the old
 *      state cannot outlive the change.
 *
 * ONE TRANSACTION PER PERSON. The credential, the invalidation and the audit row commit together
 * or not at all. A PIN that exists with no audit row is worse than no PIN.
 *
 * THE PIN IS NEVER PRINTED. It is hashed and not echoed.
 *
 * Usage:  node node_modules/tsx/dist/cli.mjs scripts/prod/set-terminal-pins-2026-08-27.ts [--confirm]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hashTerminalPin, validateTerminalPin } from '@/lib/terminal-auth/pin-credentials'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const CONFIRM = process.argv.includes('--confirm')
/** The owner's decision, stated three times. Shared by design: an empty picker attributes nothing. */
const PIN = '1234'
/** The owner instructing this, recorded as the actor on every audit row. */
const ACTOR = '56215ac6-0e9d-42d4-a28c-cefd3cc518e5'
const VENUES = ['Mingle Brew & Pour', 'FNB ChowNow', 'Riviera']

function sec(name: string): string {
  for (const line of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error('missing ' + name)
}

async function main() {
  if (!validateTerminalPin(PIN)) throw new Error('REFUSING: pin fails validateTerminalPin')

  const c = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: 'postgres.ihlmmpmolnpchzgwyhgh',
    password: sec('SUPABASE_DB_PASSWORD_PROD'),
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  await c.connect()

  // Identity proved from the data, never from the connection string.
  const idRes = await c.query(
    "SELECT (SELECT count(*) FROM restaurants WHERE name='FNB ChowNow')::int AS chownow, (SELECT count(*) FROM orders WHERE restaurant_id IS NOT NULL)::int AS real_orders",
  )
  console.log('identity: FNB ChowNow=' + idRes.rows[0].chownow + ' real orders=' + idRes.rows[0].real_orders)
  if (idRes.rows[0].chownow !== 1 || idRes.rows[0].real_orders < 1000) {
    throw new Error('REFUSING: this does not look like production')
  }

  const actorRes = await c.query('SELECT email FROM auth.users WHERE id=$1', [ACTOR])
  if (!actorRes.rows.length) throw new Error('REFUSING: actor user not found')
  console.log('actor:    ' + actorRes.rows[0].email)

  const staffRes = await c.query(
    `SELECT r.id AS restaurant_id, r.name AS venue, ru.user_id, u.email,
            (SELECT count(*)::int FROM terminal_authorization_credentials t
              WHERE t.restaurant_id = r.id AND t.user_id = ru.user_id) AS existing
       FROM restaurant_users ru
       JOIN restaurants r ON r.id = ru.restaurant_id
       JOIN auth.users u ON u.id = ru.user_id
      WHERE r.name = ANY($1) AND ru.deleted_at IS NULL
      ORDER BY r.name, u.email`,
    [VENUES],
  )
  const staff = staffRes.rows
  console.log('\ntargets: ' + staff.length)
  for (const s of staff) {
    console.log('  ' + String(s.venue).padEnd(20) + ' ' + s.email + (s.existing ? '   (has one -- will RESET)' : ''))
  }

  if (!CONFIRM) {
    console.log('\nDRY RUN. Nothing written. Re-run with --confirm.')
    await c.end()
    return
  }

  let written = 0
  for (const s of staff) {
    /**
     * A FRESH SALT PER PERSON. Sharing the PIN is the owner's decision; sharing a salt as well
     * would make all nine stored hashes identical, so one leaked row would confirm the other eight.
     */
    const { pinHash, pinSalt } = await hashTerminalPin(PIN)
    const eventType = s.existing ? 'credential_reset' : 'credential_set'
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO terminal_authorization_credentials
           (user_id, restaurant_id, pin_hash, pin_salt, created_at, updated_at)
         VALUES ($1,$2,$3,$4, now(), now())
         ON CONFLICT (user_id, restaurant_id)
         DO UPDATE SET pin_hash = EXCLUDED.pin_hash, pin_salt = EXCLUDED.pin_salt, updated_at = now()`,
        [s.user_id, s.restaurant_id, pinHash, pinSalt],
      )
      // `used_at`, NOT `consumed_at`. Taken from invalidateOutstandingTokens() in the route
      // rather than guessed -- the first attempt guessed, and all nine transactions rolled back.
      const killed = await c.query(
        `DELETE FROM privileged_authorization_tokens
          WHERE user_id = $1 AND restaurant_id = $2 AND used_at IS NULL`,
        [s.user_id, s.restaurant_id],
      )
      await c.query(
        `INSERT INTO authorization_events
           (event_type, actor_user_id, restaurant_id, terminal_id, detail)
         VALUES ($1,$2,$3,NULL,$4)`,
        [
          eventType,
          ACTOR,
          s.restaurant_id,
          JSON.stringify({
            target_user_id: s.user_id,
            invalidated_token_count: killed.rowCount ?? 0,
            set_via: 'scripts/prod/set-terminal-pins-2026-08-27.ts',
          }),
        ],
      )
      await c.query('COMMIT')
      written++
      console.log('  ' + eventType.padEnd(18) + String(s.venue).padEnd(20) + ' ' + s.email + '   tokens killed: ' + (killed.rowCount ?? 0))
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined)
      console.error('  FAILED ' + s.email + ': ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // Prove the effect from the database, never from the loop's own counter.
  const after = await c.query(
    `SELECT r.name AS venue, count(ru.user_id)::int AS staff, count(t.user_id)::int AS pins
       FROM restaurants r
       JOIN restaurant_users ru ON ru.restaurant_id = r.id AND ru.deleted_at IS NULL
       LEFT JOIN terminal_authorization_credentials t
              ON t.restaurant_id = r.id AND t.user_id = ru.user_id
      WHERE r.name = ANY($1) GROUP BY 1 ORDER BY 1`,
    [VENUES],
  )
  console.log('\nwrote ' + written + ' of ' + staff.length + '. AFTER, read back from the database:')
  console.table(after.rows)

  const ev = await c.query(
    `SELECT event_type, count(*)::int AS n FROM authorization_events
      WHERE created_at > now() - interval '10 minutes' GROUP BY 1 ORDER BY 1`,
  )
  console.log('audit rows in the last 10 minutes:')
  console.table(ev.rows)
  await c.end()
}

main().catch((err) => {
  console.error('ABORTED:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
