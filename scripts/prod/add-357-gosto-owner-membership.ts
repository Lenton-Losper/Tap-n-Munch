/**
 * ONE-OFF. Production. WRITES ONE ROW.
 *
 * #357 / #320 — the Gosto owner has no `restaurant_users` row for FNB ChowNow.
 *
 * THE RULING THIS IMPLEMENTS. The owner ruled that the transfer destination list stays scoped to
 * `restaurant_users` membership and must NOT be widened: *"a permission to create cross-location
 * transfers is not a permission to see every location in the organisation."* So the fix is not a
 * wider read — it is the missing membership. The person who should see every Gosto location should
 * see it because he is attached to those venues, not because RLS leaked.
 *
 * MEASURED: every org owner on production already holds rows for every location they own, except
 * this one. That single absence is why the org owner sees two of three locations and never the
 * busiest, and why `stock_transfers` has never had a row.
 *
 * THE ROLE IS NOT INVENTED. `restaurant_users.role` is NOT NULL with no default. This copies the
 * role the same user already holds at his other two Gosto locations -- `owner` at both -- rather
 * than choosing one. Legal values in use across the estate: owner (12), manager (5), staff (1).
 *
 * Usage:  node node_modules/tsx/dist/cli.mjs scripts/prod/add-357-gosto-owner-membership.ts [--confirm]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const CONFIRM = process.argv.includes('--confirm')
const GOSTO_OWNER = 'f9bf5348-1c1c-4574-8830-13b249722097'
const TARGET_VENUE = 'FNB ChowNow'
/** The owner instructing this, recorded as the actor. */
const ACTOR = '56215ac6-0e9d-42d4-a28c-cefd3cc518e5'

function sec(name: string): string {
  for (const line of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error('missing ' + name)
}

async function main() {
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

  const idRes = await c.query(
    "SELECT (SELECT count(*) FROM restaurants WHERE name='FNB ChowNow')::int AS chownow, (SELECT count(*) FROM orders WHERE restaurant_id IS NOT NULL)::int AS real_orders",
  )
  console.log('identity: FNB ChowNow=' + idRes.rows[0].chownow + ' real orders=' + idRes.rows[0].real_orders)
  if (idRes.rows[0].chownow !== 1 || idRes.rows[0].real_orders < 1000) {
    throw new Error('REFUSING: this does not look like production')
  }

  // ---- preconditions, re-derived at the moment of the write
  const fail: string[] = []

  const venue = await c.query('SELECT id, organization_id FROM restaurants WHERE name=$1', [TARGET_VENUE])
  if (venue.rows.length !== 1) fail.push('target venue not found or ambiguous')
  const restaurantId = venue.rows[0]?.id

  const existing = await c.query(
    'SELECT count(*)::int AS n FROM restaurant_users WHERE restaurant_id=$1 AND user_id=$2',
    [restaurantId, GOSTO_OWNER],
  )
  console.log('1. row already present ............ ' + existing.rows[0].n + '   <- must be 0')
  if (existing.rows[0].n !== 0) fail.push('the membership row already exists')

  // The role is COPIED, not chosen. If his other memberships ever disagree, stop rather than pick.
  const siblings = await c.query(
    `SELECT DISTINCT ru.role FROM restaurant_users ru
       JOIN restaurants r ON r.id = ru.restaurant_id
      WHERE ru.user_id = $1 AND ru.deleted_at IS NULL AND r.organization_id = $2`,
    [GOSTO_OWNER, venue.rows[0]?.organization_id],
  )
  const roles = siblings.rows.map((r: { role: string }) => r.role)
  console.log('2. his role at other Gosto venues . ' + JSON.stringify(roles) + '   <- must be exactly one')
  if (roles.length !== 1) fail.push('his existing roles disagree (' + JSON.stringify(roles) + ') -- a human chooses')
  const role = roles[0]

  // He must actually be an org owner, or this is the wrong person entirely.
  const orgRole = await c.query(
    'SELECT role FROM organization_users WHERE user_id=$1 AND organization_id=$2',
    [GOSTO_OWNER, venue.rows[0]?.organization_id],
  )
  console.log('3. his organization_users role .... ' + (orgRole.rows[0]?.role ?? 'NONE') + '   <- must be an owner')
  if (String(orgRole.rows[0]?.role ?? '').toLowerCase() !== 'owner') fail.push('not an org owner')

  // The venue must belong to the org we think it does.
  console.log('4. venue is in his organisation ... ' + (venue.rows[0]?.organization_id ? 'yes' : 'NO'))
  if (!venue.rows[0]?.organization_id) fail.push('venue has no organization_id')

  if (fail.length) {
    console.log('\nREFUSING. Preconditions that did not hold:')
    for (const f of fail) console.log('  - ' + f)
    await c.end()
    process.exitCode = 2
    return
  }

  console.log('\nAll preconditions hold. Would add: ' + TARGET_VENUE + ' / role=' + role)
  if (!CONFIRM) {
    console.log('DRY RUN. Nothing written. Re-run with --confirm.')
    await c.end()
    return
  }

  try {
    await c.query('BEGIN')
    await c.query(
      `INSERT INTO restaurant_users (restaurant_id, user_id, role, invited_by, invite_accepted)
       VALUES ($1,$2,$3,$4,true)`,
      [restaurantId, GOSTO_OWNER, role, ACTOR],
    )
    await c.query(
      `INSERT INTO audit_logs (restaurant_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'restaurant_user.added','restaurant_user',$2,$3)`,
      [
        restaurantId,
        GOSTO_OWNER,
        JSON.stringify({
          actor_user_id: ACTOR,
          role,
          reason: 'issue-357: org owner had no membership row for this location; the ruling is that the transfer destination list stays scoped to restaurant_users membership, so the fix is the row rather than a wider read',
          set_via: 'scripts/prod/add-357-gosto-owner-membership.ts',
        }),
      ],
    )
    await c.query('COMMIT')
    console.log('WROTE the membership row and its audit row in one transaction.')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined)
    console.error('FAILED, rolled back:', err instanceof Error ? err.message : String(err))
    await c.end()
    process.exitCode = 1
    return
  }

  // Prove the effect, and prove the thing it was FOR.
  const after = await c.query(
    `SELECT r.name AS venue, ru.role FROM restaurant_users ru
       JOIN restaurants r ON r.id = ru.restaurant_id
      WHERE ru.user_id=$1 AND ru.deleted_at IS NULL ORDER BY r.name`,
    [GOSTO_OWNER],
  )
  console.log('\nAFTER -- his memberships:')
  console.table(after.rows)

  const shared = await c.query(
    `SELECT count(*)::int AS shared_items
       FROM organization_stock_items osi
      WHERE EXISTS (SELECT 1 FROM stock_items s WHERE s.organization_stock_item_id = osi.id AND s.restaurant_id = $1 AND s.is_active)
        AND EXISTS (SELECT 1 FROM stock_items s WHERE s.organization_stock_item_id = osi.id AND s.restaurant_id = $2 AND s.is_active)`,
    [restaurantId, (await c.query("SELECT id FROM restaurants WHERE name='Chownow Nedbank'")).rows[0]?.id],
  )
  console.log('items FNB ChowNow and Chownow Nedbank now BOTH stock: ' + shared.rows[0].shared_items)
  console.log('  (this is the pair that shares items and was previously unselectable)')
  await c.end()
}

main().catch((err) => {
  console.error('ABORTED:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
