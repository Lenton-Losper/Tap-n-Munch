/**
 * Production verification: restaurant_tables RLS select lockdown.
 *   npx tsx scripts/verify-restaurant-tables-rls-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'

config({ path: '.env.production.local', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const CHOWNOW_ID = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const RIVIERA_TABLE = 1
const CHOWNOW_TABLE = 1
const CHOWNOW_KIOSK = 99
const tag = `tables-rls-prod-${Date.now()}`
const pw = `Verify${randomUUID().slice(0, 8)}!1`

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!url?.includes(PROD_REF)) throw new Error(`Refusing: not production Supabase (${url})`)

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
let inactiveTableId: string | null = null
let disposableTableId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function resolveRivieraOwnerEmail(): Promise<string> {
  const { data: ownerRow, error } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!ownerRow?.user_id) throw new Error('No Riviera owner')
  const { data: userRow, error: userError } = await dbAdmin
    .from('users')
    .select('email')
    .eq('id', ownerRow.user_id)
    .maybeSingle()
  if (userError) throw userError
  const email = String(userRow?.email || '').trim()
  if (!email) throw new Error('Riviera owner has no email')
  return email
}

async function signInWithMagicLink(email: string) {
  const { data: link, error: linkErr } = await authAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    throw new Error(`Magic link failed: ${linkErr?.message}`)
  }
  const { data: sess, error: otpErr } = await authAdmin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token) throw new Error(`OTP failed: ${otpErr?.message}`)
  return sess.session.access_token
}

async function signInDisposable(email: string) {
  const { data, error } = await anonAuth.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session) throw new Error(`Sign-in failed: ${error?.message}`)
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

async function setupDisposable() {
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

  const { data: inactive, error: inactiveErr } = await dbAdmin
    .from('restaurant_tables')
    .insert({
      restaurant_id: restAId!,
      table_number: 901,
      table_name: 'Inactive probe',
      qr_code_url: `https://example.invalid/menu/${restAId}/901`,
      active: false,
    })
    .select('id')
    .single()
  if (inactiveErr || !inactive?.id) throw inactiveErr
  inactiveTableId = String(inactive.id)

  const { data: active, error: activeErr } = await dbAdmin
    .from('restaurant_tables')
    .insert({
      restaurant_id: restBId!,
      table_number: 902,
      table_name: 'Table 902',
      qr_code_url: `https://example.invalid/menu/${restBId}/902`,
      active: true,
    })
    .select('id')
    .single()
  if (activeErr || !active?.id) throw activeErr

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

async function anonPointLookup(restaurantId: string, tableNumber: number) {
  const { data, error } = await anonGuest
    .from('restaurant_tables')
    .select('id, restaurant_id, table_number, active, is_kiosk, table_name')
    .eq('restaurant_id', restaurantId)
    .eq('table_number', tableNumber)
    .eq('active', true)
    .maybeSingle()
  return { error: error?.message ?? null, row: data }
}

async function probeGuestPage(path: string) {
  const res = await fetch(`${APP}${path}`, { redirect: 'follow' })
  const body = await res.text()
  return {
    status: res.status,
    finalUrl: res.url,
    blocked:
      // #273 renamed this refusal and gave it a CODE. Match the code, not the prose: the old
      // substring is placeholder copy now, and a probe keyed to a sentence stops checking
      // anything the moment the sentence is rewritten.
      body.includes('MENU_ITEM_NOT_ORDERABLE') ||
      body.includes('MENU_ITEM_NOT_FOUND') ||
      body.includes('no longer on the menu') ||
      body.includes('not configured as a kiosk') ||
      body.includes('This kiosk is not available') ||
      body.includes('invalid'),
    hasOrderingUi:
      body.includes('Browse') ||
      body.includes('Start Order') ||
      body.includes('Your name') ||
      body.includes('Join') ||
      body.includes('Create') ||
      body.includes('menu'),
  }
}

async function cleanup(disposableTableIdToDelete: string | null) {
  if (inactiveTableId) {
    await dbAdmin.from('restaurant_tables').delete().eq('id', inactiveTableId)
  }
  if (disposableTableIdToDelete) {
    await dbAdmin.from('restaurant_tables').delete().eq('id', disposableTableIdToDelete)
  }
  for (const uid of [ownerAId, ownerBId]) {
    if (!uid) continue
    await dbAdmin.from('restaurant_users').delete().eq('user_id', uid)
    await dbAdmin.from('users').delete().eq('id', uid)
    await authAdmin.auth.admin.deleteUser(uid)
  }
  for (const restId of [restAId, restBId]) {
    if (!restId) continue
    await dbAdmin.from('restaurant_tables').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
}

async function main() {
  await setupDisposable()

  const ownerASession = await signInDisposable(ownerAEmail)
  const ownerAClient = await clientForSession(ownerASession)

  const crossTenant = await ownerAClient
    .from('restaurant_tables')
    .select('id, restaurant_id')
    .eq('restaurant_id', restBId!)
    .limit(5)

  const rivieraOwnerEmail = await resolveRivieraOwnerEmail()
  const rivieraOwnerTok = await signInWithMagicLink(rivieraOwnerEmail)
  const rivieraOwnerClient = createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${rivieraOwnerTok}` } },
  })

  const rivieraStaffRead = await rivieraOwnerClient
    .from('restaurant_tables')
    .select('id, table_number, active')
    .eq('restaurant_id', RIVIERA_ID)
    .order('table_number')

  const guestPatterns = {
    note: 'Production guest flows use same anon client point lookups as staging: restaurant_id + table_number + active=true',
    rivieraTable1: await anonPointLookup(RIVIERA_ID, RIVIERA_TABLE),
    chownowTable1: await anonPointLookup(CHOWNOW_ID, CHOWNOW_TABLE),
    chownowKiosk99: await anonPointLookup(CHOWNOW_ID, CHOWNOW_KIOSK),
  }

  const guestPages = {
    rivieraV2: await probeGuestPage(`/menu/${RIVIERA_ID}/v2?table=${RIVIERA_TABLE}`),
    chownowV2: await probeGuestPage(`/menu/${CHOWNOW_ID}/v2?table=${CHOWNOW_TABLE}`),
    chownowKiosk: await probeGuestPage(`/menu/${CHOWNOW_ID}/kiosk?table=${CHOWNOW_KIOSK}`),
  }

  const inactiveAnon = await anonGuest
    .from('restaurant_tables')
    .select('id')
    .eq('id', inactiveTableId!)
    .maybeSingle()

  const inactiveStaff = await ownerAClient
    .from('restaurant_tables')
    .select('id, active')
    .eq('id', inactiveTableId!)
    .maybeSingle()

  const createRes = await fetch(`${APP}/api/admin/tables`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${rivieraOwnerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ kind: 'table', table_number: 9876 }),
  })
  const createBody = await createRes.json().catch(() => ({}))
  disposableTableId = String((createBody as { table?: { id?: string } }).table?.id || '') || null

  let patchStatus: number | null = null
  let deactivateStatus: number | null = null
  let anonHiddenAfterDeactivate = false
  if (disposableTableId) {
    patchStatus = (
      await fetch(`${APP}/api/admin/tables/${encodeURIComponent(disposableTableId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${rivieraOwnerTok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ restaurantId: RIVIERA_ID, location: 'RLS verify probe' }),
      })
    ).status

    deactivateStatus = (
      await fetch(`${APP}/api/admin/tables/${encodeURIComponent(disposableTableId)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${rivieraOwnerTok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ restaurantId: RIVIERA_ID, active: false }),
      })
    ).status

    const hiddenWhenInactive = await anonGuest
      .from('restaurant_tables')
      .select('id')
      .eq('id', disposableTableId)
      .eq('active', true)
      .maybeSingle()

    anonHiddenAfterDeactivate = !hiddenWhenInactive.data
  }

  const report = {
    app: APP,
    tag,
    crossTenantStaffRead: {
      error: crossTenant.error?.message ?? null,
      rowCount: crossTenant.data?.length ?? 0,
    },
    rivieraOwnerStaffRead: {
      email: rivieraOwnerEmail,
      rowCount: rivieraStaffRead.data?.length ?? 0,
      hasInactiveOnRiviera: (rivieraStaffRead.data || []).some((r) => r.active === false),
      tableNumbersSample: (rivieraStaffRead.data || []).slice(0, 5).map((r) => r.table_number),
    },
    guestPointLookups: guestPatterns,
    liveGuestPages: guestPages,
    inactiveProbe: {
      anonSeesInactiveDisposable: Boolean(inactiveAnon.data?.id),
      staffSeesInactiveDisposable: Boolean(inactiveStaff.data?.id),
      anonHiddenAfterDeactivate,
    },
    phase5cWrites: {
      create: createRes.status,
      patch: patchStatus,
      deactivate: deactivateStatus,
    },
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    (crossTenant.data?.length ?? 0) === 0 &&
    (rivieraStaffRead.data?.length ?? 0) >= 11 &&
    Boolean(guestPatterns.rivieraTable1.row?.id) &&
    Boolean(guestPatterns.chownowTable1.row?.id) &&
    Boolean(guestPatterns.chownowKiosk99.row?.is_kiosk) &&
    !guestPages.rivieraV2.blocked &&
    guestPages.rivieraV2.status === 200 &&
    !guestPages.chownowV2.blocked &&
    guestPages.chownowV2.status === 200 &&
    !guestPages.chownowKiosk.blocked &&
    guestPages.chownowKiosk.status === 200 &&
    !inactiveAnon.data &&
    Boolean(inactiveStaff.data?.id) &&
    createRes.status === 200 &&
    patchStatus === 200 &&
    deactivateStatus === 200 &&
    anonHiddenAfterDeactivate === true

  if (!pass) {
    console.error('RESTAURANT_TABLES_RLS_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('RESTAURANT_TABLES_RLS_PRODUCTION_OK')
  }

  await cleanup(disposableTableId)
}

main()
  .catch(async (e) => {
    console.error(e)
    process.exitCode = 1
    try {
      await cleanup(disposableTableId)
    } catch {
      /* ignore */
    }
  })
