import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.production.local', override: true })

const APP = 'https://www.flashtap.app'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const tag = `sec-gap3-${Date.now()}`
const pw = `Kit${randomUUID().slice(0, 8)}!1`

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const auth = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const anon = createClient(url, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } })

const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`
const ownerEmail = `${tag}.owner@flashtap-test.invalid`

let restId: string | null = null
let ownerId: string | null = null
let kitchenId: string | null = null
let termId: string | null = null

async function callList(token: string, label: string) {
  const res = await fetch(`${APP}/api/admin/terminals/list`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json().catch(() => ({}))
  return { label, status: res.status, body }
}

async function main() {
  const { data: r, error: rErr } = await db
    .from('restaurants')
    .insert({ name: `${tag} R`, slug: tag })
    .select('id')
    .single()
  if (rErr) throw rErr
  restId = r.id

  const { data: o, error: oErr } = await auth.auth.admin.createUser({
    email: ownerEmail,
    password: pw,
    email_confirm: true,
  })
  if (oErr || !o.user) throw oErr
  ownerId = o.user.id

  const { data: k, error: kErr } = await auth.auth.admin.createUser({
    email: kitchenEmail,
    password: pw,
    email_confirm: true,
  })
  if (kErr || !k.user) throw kErr
  kitchenId = k.user.id

  const { error: ownerUserErr } = await db.from('users').insert({
    id: ownerId,
    email: ownerEmail,
    full_name: 'Gap3 Owner',
    role: 'owner',
    restaurant_id: restId,
  })
  if (ownerUserErr) throw ownerUserErr

  const { error: kitchenUserErr } = await db.from('users').insert({
    id: kitchenId,
    email: kitchenEmail,
    full_name: 'Gap3 Kitchen',
    role: 'kitchen',
    restaurant_id: restId,
  })
  if (kitchenUserErr) throw kitchenUserErr

  const { error: ruErr } = await db.from('restaurant_users').insert([
    { restaurant_id: restId, user_id: ownerId, role: 'owner', invite_accepted: true },
    { restaurant_id: restId, user_id: kitchenId, role: 'kitchen', invite_accepted: true },
  ])
  if (ruErr) throw ruErr

  const { data: t, error: tErr } = await db
    .from('restaurant_terminals')
    .insert({
      restaurant_id: restId,
      terminal_name: `${tag} T`,
      status: 'active',
      active: true,
      device_serial: `${tag}-serial`,
      activation_code: 'TESTCODE12',
    })
    .select('id')
    .single()
  if (tErr) throw tErr
  termId = t.id

  const { data: kitchenS } = await anon.auth.signInWithPassword({ email: kitchenEmail, password: pw })
  const { data: ownerS } = await anon.auth.signInWithPassword({ email: ownerEmail, password: pw })

  const kitchenToken = kitchenS.session!.access_token
  const ownerToken = ownerS.session!.access_token

  const results = [
    await callList(kitchenToken, 'kitchen'),
    await callList(ownerToken, 'owner'),
  ]

  console.log(JSON.stringify({ tag, restId, results }, null, 2))
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (termId) await db.from('restaurant_terminals').delete().eq('id', termId)
    if (restId) {
      await db.from('restaurant_users').delete().eq('restaurant_id', restId)
      await db.from('restaurants').delete().eq('id', restId)
    }
    for (const id of [ownerId, kitchenId]) {
      if (id) {
        await db.from('users').delete().eq('id', id)
        await auth.auth.admin.deleteUser(id)
      }
    }
  })
