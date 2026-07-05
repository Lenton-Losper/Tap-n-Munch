/**
 * Staging verification: restaurant_tables RLS select lockdown.
 *   npx tsx scripts/verify-restaurant-tables-rls-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const E2E_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const E2E_TABLE_NUMBER = 1
const E2E_KIOSK_TABLE_NUMBER = 1001
const tag = `tables-rls-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase')

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonGuest = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonAuth = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let ownerBId: string | null = null
let tableAId: string | null = null
let tableBId: string | null = null
let inactiveTableAId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anonAuth.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session
}

async function clientForSession(session: { access_token: string; refresh_token: string }) {
  const client = createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  return client
}

async function seedRestaurantRoles(restaurantId: string) {
  const rows = rolePermissionConfigEntries().map(([slug, perms]) => ({
    restaurant_id: restaurantId,
    role_slug: slug,
    display_name: slug,
    permissions: [...perms],
    is_system: slug === 'owner',
    is_invite_eligible: slug === 'manager' || slug === 'waiter',
  }))
  const { error } = await dbAdmin.from('restaurant_roles').insert(rows)
  if (error) throw error
}

async function setup() {
  for (const [slug, label] of [
    [`${tag}-a`, 'a'],
    [`${tag}-b`, 'b'],
  ] as const) {
    const { data: rest, error } = await dbAdmin
      .from('restaurants')
      .insert({ name: `${slug} Restaurant`, slug })
      .select('id')
      .single()
    if (error || !rest?.id) throw error
    if (label === 'a') restAId = rest.id
    else restBId = rest.id
    await seedRestaurantRoles(rest.id)
  }

  const { data: tableA, error: tableAErr } = await dbAdmin
    .from('restaurant_tables')
    .insert({
      restaurant_id: restAId!,
      table_number: 701,
      table_name: 'Table 701',
      qr_code_url: `https://example.invalid/menu/${restAId}/701`,
      active: true,
    })
    .select('id')
    .single()
  if (tableAErr || !tableA?.id) throw tableAErr
  tableAId = String(tableA.id)

  const { data: inactiveA, error: inactiveErr } = await dbAdmin
    .from('restaurant_tables')
    .insert({
      restaurant_id: restAId!,
      table_number: 702,
      table_name: 'Table 702 inactive',
      qr_code_url: `https://example.invalid/menu/${restAId}/702`,
      active: false,
    })
    .select('id')
    .single()
  if (inactiveErr || !inactiveA?.id) throw inactiveErr
  inactiveTableAId = String(inactiveA.id)

  const { data: tableB, error: tableBErr } = await dbAdmin
    .from('restaurant_tables')
    .insert({
      restaurant_id: restBId!,
      table_number: 703,
      table_name: 'Table 703',
      qr_code_url: `https://example.invalid/menu/${restBId}/703`,
      active: true,
    })
    .select('id')
    .single()
  if (tableBErr || !tableB?.id) throw tableBErr
  tableBId = String(tableB.id)

  for (const [email, role, label] of [
    [ownerAEmail, 'owner', 'ownerA'],
    [ownerBEmail, 'owner', 'ownerB'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    const restId = label === 'ownerA' ? restAId! : restBId!
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id
    await dbAdmin.from('users').insert({
      id: u.user.id,
      email,
      role,
      restaurant_id: restId,
      full_name: `TablesRLS ${label}`,
    })
    await dbAdmin.from('restaurant_users').insert({
      restaurant_id: restId,
      user_id: u.user.id,
      role,
      invite_accepted: true,
    })
  }
}

async function cleanup() {
  for (const id of [tableAId, tableBId, inactiveTableAId]) {
    if (id) await dbAdmin.from('restaurant_tables').delete().eq('id', id)
  }
  for (const uid of [ownerAId, ownerBId]) {
    if (!uid) continue
    await dbAdmin.from('restaurant_users').delete().eq('user_id', uid)
    await dbAdmin.from('users').delete().eq('id', uid)
    await authAdmin.auth.admin.deleteUser(uid)
  }
  for (const restId of [restAId, restBId]) {
    if (!restId) continue
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
}

async function anonRead(restaurantId: string, tableNumber: number) {
  const { data, error } = await anonGuest
    .from('restaurant_tables')
    .select('id, restaurant_id, table_number, active, is_kiosk')
    .eq('restaurant_id', restaurantId)
    .eq('table_number', tableNumber)
    .eq('active', true)
    .maybeSingle()
  return { error: error?.message ?? null, row: data }
}

async function main() {
  await setup()

  const ownerASession = await signIn(ownerAEmail)
  const ownerAClient = await clientForSession(ownerASession)

  const crossTenant = await ownerAClient
    .from('restaurant_tables')
    .select('id')
    .eq('restaurant_id', restBId!)
    .limit(5)

  const ownRestaurant = await ownerAClient
    .from('restaurant_tables')
    .select('id, table_number, active')
    .eq('restaurant_id', restAId!)
    .order('table_number')

  const anonActiveOwn = await anonRead(restAId!, 701)
  const anonInactive = await anonGuest
    .from('restaurant_tables')
    .select('id')
    .eq('restaurant_id', restAId!)
    .eq('table_number', 702)
    .eq('active', true)
    .maybeSingle()

  const anonE2eTable = await anonRead(E2E_RESTAURANT_ID, E2E_TABLE_NUMBER)
  const anonE2eKiosk = await anonRead(E2E_RESTAURANT_ID, E2E_KIOSK_TABLE_NUMBER)

  const guestMenuRes = await fetch(
    `${APP}/menu/${E2E_RESTAURANT_ID}/v2?table=${E2E_TABLE_NUMBER}`,
  )
  const guestMenuBody = await guestMenuRes.text()
  const kioskRes = await fetch(
    `${APP}/menu/${E2E_RESTAURANT_ID}/kiosk?table=${E2E_KIOSK_TABLE_NUMBER}`,
  )
  const kioskBody = await kioskRes.text()

  const ownerTok = ownerASession.access_token
  const staffCreate = await fetch(`${APP}/api/admin/tables`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kind: 'table', table_number: 704 }),
  })
  let createdTableId: string | null = null
  if (staffCreate.status === 200) {
    const body = await staffCreate.json().catch(() => ({}))
    createdTableId = String((body as { table?: { id?: string } }).table?.id || '') || null
  }

  const report = {
    app: APP,
    tag,
    crossTenantStaffRead: {
      error: crossTenant.error?.message ?? null,
      rowCount: crossTenant.data?.length ?? 0,
    },
    ownRestaurantStaffRead: {
      error: ownRestaurant.error?.message ?? null,
      rowCount: ownRestaurant.data?.length ?? 0,
      tableNumbers: (ownRestaurant.data || []).map((r) => r.table_number),
    },
    anonGuestReads: {
      activeFixture: anonActiveOwn,
      inactiveBlocked: { row: anonInactive.data, error: anonInactive.error?.message ?? null },
      e2eTable: anonE2eTable,
      e2eKiosk: anonE2eKiosk,
    },
    guestHttpFlows: {
      menuV2: { status: guestMenuRes.status, hasUnavailable: guestMenuBody.includes('not available') },
      kiosk: {
        status: kioskRes.status,
        blocked: kioskBody.includes('not configured') || kioskBody.includes('not available'),
        hasNamePrompt: kioskBody.includes('Your name'),
      },
    },
    phase5cStaffWrite: { createStatus: staffCreate.status },
  }

  if (createdTableId) {
    await dbAdmin.from('restaurant_tables').delete().eq('id', createdTableId)
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    (crossTenant.data?.length ?? 0) === 0 &&
    !crossTenant.error &&
    (ownRestaurant.data?.length ?? 0) >= 2 &&
    Boolean(anonActiveOwn.row?.id) &&
    !anonInactive.data &&
    Boolean(anonE2eTable.row?.id) &&
    Boolean(anonE2eKiosk.row?.id) &&
    guestMenuRes.status === 200 &&
    !guestMenuBody.includes('not available for ordering') &&
    kioskRes.status === 200 &&
    staffCreate.status === 200

  if (!pass) {
    console.error('RESTAURANT_TABLES_RLS_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('RESTAURANT_TABLES_RLS_STAGING_OK')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await cleanup()
      console.log('Cleanup complete.')
    } catch (e) {
      console.error('Cleanup failed:', e)
    }
  })
