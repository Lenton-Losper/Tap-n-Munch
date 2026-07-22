import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const tag = `sec-gap4-${Date.now()}`
const pw = `T${randomUUID().slice(0, 8)}!1`

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const auth = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const anon = createClient(url, anonKey!, { auth: { autoRefreshToken: false, persistSession: false } })

let restA: string | null = null
let restB: string | null = null
let ownerA: string | null = null
let ownerB: string | null = null
let kitchenA: string | null = null
let termA: string | null = null
let termB: string | null = null

function client(token: string) {
  return createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw error
  return data.session.access_token
}

async function main() {
  const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
  const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`
  const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`

  const { data: a } = await db.from('restaurants').insert({ name: `${tag} A`, slug: `${tag}-a` }).select('id').single()
  const { data: b } = await db.from('restaurants').insert({ name: `${tag} B`, slug: `${tag}-b` }).select('id').single()
  restA = a!.id
  restB = b!.id

  for (const [email, label] of [
    [ownerAEmail, 'ownerA'],
    [ownerBEmail, 'ownerB'],
    [kitchenEmail, 'kitchen'],
  ] as const) {
    const { data: u } = await auth.auth.admin.createUser({ email, password: pw, email_confirm: true })
    if (label === 'ownerA') ownerA = u.user!.id
    if (label === 'ownerB') ownerB = u.user!.id
    if (label === 'kitchen') kitchenA = u.user!.id
  }

  await db.from('users').insert([
    { id: ownerA, email: ownerAEmail, role: 'owner', restaurant_id: restA, full_name: 'A' },
    { id: ownerB, email: ownerBEmail, role: 'owner', restaurant_id: restB, full_name: 'B' },
    { id: kitchenA, email: kitchenEmail, role: 'kitchen', restaurant_id: restA, full_name: 'K' },
  ])
  await db.from('restaurant_users').insert([
    { restaurant_id: restA, user_id: ownerA, role: 'owner', invite_accepted: true },
    { restaurant_id: restB, user_id: ownerB, role: 'owner', invite_accepted: true },
    { restaurant_id: restA, user_id: kitchenA, role: 'kitchen', invite_accepted: true },
  ])

  const { data: ta } = await db
    .from('restaurant_terminals')
    .insert({ restaurant_id: restA, terminal_name: 'TA', status: 'active', active: true, device_serial: `${tag}-a` })
    .select('id')
    .single()
  const { data: tb } = await db
    .from('restaurant_terminals')
    .insert({ restaurant_id: restB, terminal_name: 'TB', status: 'active', active: true, device_serial: `${tag}-b` })
    .select('id')
    .single()
  termA = ta!.id
  termB = tb!.id

  const kitchenToken = await signIn(kitchenEmail)
  const ownerAToken = await signIn(ownerAEmail)
  const kitchenC = client(kitchenToken)
  const ownerAC = client(ownerAToken)

  const tests = {
    kitchenReadOwn: await kitchenC.from('restaurant_terminals').select('id,status,activation_code').eq('id', termA!).maybeSingle(),
    kitchenReadCross: await kitchenC.from('restaurant_terminals').select('id,status').eq('id', termB!).maybeSingle(),
    kitchenDeactivateOwn: await kitchenC.from('restaurant_terminals').update({ status: 'inactive' }).eq('id', termA!).select('id'),
    kitchenDeactivateCross: await kitchenC.from('restaurant_terminals').update({ status: 'inactive' }).eq('id', termB!).select('id'),
    ownerADeactivateCross: await ownerAC.from('restaurant_terminals').update({ status: 'inactive' }).eq('id', termB!).select('id'),
    ownerADeactivateOwn: await ownerAC.from('restaurant_terminals').update({ status: 'inactive' }).eq('id', termA!).select('id,status'),
  }

  const { data: finalA } = await db.from('restaurant_terminals').select('status').eq('id', termA!).single()
  const { data: finalB } = await db.from('restaurant_terminals').select('status').eq('id', termB!).single()

  console.log(
    JSON.stringify(
      {
        liveRls: {
          select: 'any restaurant_users member can SELECT own-restaurant terminals',
          manage: 'only role=owner can UPDATE/DELETE (ALL policy)',
        },
        kitchenReadOwn: { data: tests.kitchenReadOwn.data, error: tests.kitchenReadOwn.error?.message },
        kitchenReadCross: { data: tests.kitchenReadCross.data, error: tests.kitchenReadCross.error?.message },
        kitchenDeactivateOwn: { rows: tests.kitchenDeactivateOwn.data, error: tests.kitchenDeactivateOwn.error?.message },
        kitchenDeactivateCross: { rows: tests.kitchenDeactivateCross.data, error: tests.kitchenDeactivateCross.error?.message },
        ownerADeactivateCross: { rows: tests.ownerADeactivateCross.data, error: tests.ownerADeactivateCross.error?.message },
        ownerADeactivateOwn: { rows: tests.ownerADeactivateOwn.data, error: tests.ownerADeactivateOwn.error?.message },
        finalStatuses: { termA: finalA?.status, termB: finalB?.status },
      },
      null,
      2,
    ),
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    if (termA) await db.from('restaurant_terminals').delete().eq('id', termA)
    if (termB) await db.from('restaurant_terminals').delete().eq('id', termB)
    for (const rid of [restA, restB]) {
      if (rid) {
        await db.from('restaurant_users').delete().eq('restaurant_id', rid)
        await db.from('restaurants').delete().eq('id', rid)
      }
    }
    for (const uid of [ownerA, ownerB, kitchenA]) {
      if (uid) {
        await db.from('users').delete().eq('id', uid)
        await auth.auth.admin.deleteUser(uid)
      }
    }
  })
