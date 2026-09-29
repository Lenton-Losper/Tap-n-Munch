#!/usr/bin/env node
/**
 * A TEMPORARY STAGING MANAGER for the staging E2E invoice/reconcile steps. Staging only.
 *
 *   node scripts/staging/temp-manager.mjs create <tokenFile>   create + sign in; token -> file (never printed)
 *   node scripts/staging/temp-manager.mjs delete               delete every user this script created
 *
 * Refuses unless SUPABASE_URL is the staging project (ref mdqjpxwczrhkxkbqatqa) and the service key's
 * own claims say ref=staging, role=service_role. Users are tagged by email prefix so `delete` finds
 * every one this script ever made, including after a crash.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const VENUE = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // "staging test"
const PREFIX = 'sprint-e2e-temp-manager+'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.test'

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
)
const URL_ = env.SUPABASE_URL
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
const ANON = env.SUPABASE_ANON_KEY
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
if (!URL_?.startsWith(`https://${STAGING_REF}.`)) throw new Error('REFUSING: SUPABASE_URL is not staging')
if (claims(SERVICE).ref !== STAGING_REF || claims(SERVICE).role !== 'service_role') throw new Error('REFUSING: service key is not staging service_role')
if (claims(ANON).ref !== STAGING_REF) throw new Error('REFUSING: anon key is not staging')

const svc = (path, init = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })

async function listOurs() {
  const r = await svc('/auth/v1/admin/users?per_page=1000')
  if (!r.ok) throw new Error('list users ' + r.status)
  const body = await r.json()
  return (body.users ?? []).filter((u) => String(u.email ?? '').startsWith(PREFIX))
}

const [cmd, tokenFile] = process.argv.slice(2)
if (cmd === 'create') {
  if (!tokenFile) throw new Error('usage: create <tokenFile>')
  const email = `${PREFIX}${Date.now()}@example.com`
  const password = randomBytes(24).toString('base64url')
  const cu = await svc('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) })
  if (!cu.ok) throw new Error('create user ' + cu.status + ' ' + (await cu.text()).slice(0, 200))
  const user = await cu.json()
  const pu = await svc('/rest/v1/users', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: user.id, email }),
  })
  if (!pu.ok && pu.status !== 409) console.error('public.users insert', pu.status, (await pu.text()).slice(0, 200))
  const ru = await svc('/rest/v1/restaurant_users', {
    method: 'POST',
    body: JSON.stringify({ user_id: user.id, restaurant_id: VENUE, role: 'manager' }),
  })
  if (!ru.ok) throw new Error('membership ' + ru.status + ' ' + (await ru.text()).slice(0, 300))
  const si = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!si.ok) throw new Error('sign in ' + si.status)
  const { access_token } = await si.json()
  writeFileSync(tokenFile, access_token)
  console.log(`created temp manager ${user.id} on the staging test venue; token written (not printed)`)
} else if (cmd === 'delete') {
  const ours = await listOurs()
  for (const u of ours) {
    await svc(`/rest/v1/restaurant_users?user_id=eq.${u.id}`, { method: 'DELETE' })
    await svc(`/rest/v1/users?id=eq.${u.id}`, { method: 'DELETE' })
    const d = await svc(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' })
    console.log(`deleted ${u.id}: auth ${d.status}`)
  }
  console.log(`${ours.length} temp manager(s) removed; remaining: ${(await listOurs()).length}`)
} else {
  throw new Error('usage: create <tokenFile> | delete')
}
