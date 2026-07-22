/**
 * Production exploit probes: cross-tenant + anon menu table writes via anon-key client.
 * Uses disposable restaurants only. Cleanup always runs.
 *   npx tsx scripts/audit-menu-tables-rls-probes-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'

config({ path: '.env.production.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const tag = `menu-rls-probe-prod-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!
if (!url?.includes(PROD_REF)) throw new Error('Refusing: not production Supabase')

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
let categoryAId: string | null = null
let categoryBId: string | null = null
let subcategoryAId: string | null = null
let subcategoryBId: string | null = null
let itemAId: string | null = null
let itemBId: string | null = null
const probeIds: { table: string; id: string }[] = []
const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`

async function signIn(email: string) {
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

  const { data: u, error: uErr } = await authAdmin.auth.admin.createUser({
    email: ownerAEmail,
    password: pw,
    email_confirm: true,
  })
  if (uErr || !u.user) throw uErr
  ownerAId = u.user.id
  await dbAdmin.from('users').insert({
    id: ownerAId,
    email: ownerAEmail,
    role: 'owner',
    restaurant_id: restAId!,
    full_name: 'Menu RLS probe owner A',
  })
  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: restAId!,
    user_id: ownerAId,
    role: 'owner',
    invite_accepted: true,
  })

  const { data: catA } = await dbAdmin
    .from('menu_categories')
    .insert({ restaurant_id: restAId!, name: `${tag} Cat A`, active: true, route_to: 'kitchen' })
    .select('id')
    .single()
  categoryAId = String(catA!.id)

  const { data: catB } = await dbAdmin
    .from('menu_categories')
    .insert({ restaurant_id: restBId!, name: `${tag} Cat B`, active: true, route_to: 'kitchen' })
    .select('id')
    .single()
  categoryBId = String(catB!.id)

  const { data: subA } = await dbAdmin
    .from('menu_subcategories')
    .insert({ restaurant_id: restAId!, category_id: categoryAId, name: `${tag} Sub A` })
    .select('id')
    .single()
  subcategoryAId = String(subA!.id)

  const { data: subB } = await dbAdmin
    .from('menu_subcategories')
    .insert({ restaurant_id: restBId!, category_id: categoryBId, name: `${tag} Sub B` })
    .select('id')
    .single()
  subcategoryBId = String(subB!.id)

  const { data: itemA } = await dbAdmin
    .from('menu_items')
    .insert({
      restaurant_id: restAId!,
      category_id: categoryAId,
      subcategory_id: subcategoryAId,
      name: `${tag} Item A`,
      base_price: 5,
      status: 'available',
    })
    .select('id')
    .single()
  itemAId = String(itemA!.id)

  const { data: itemB } = await dbAdmin
    .from('menu_items')
    .insert({
      restaurant_id: restBId!,
      category_id: categoryBId,
      subcategory_id: subcategoryBId,
      name: `${tag} Item B`,
      base_price: 7,
      status: 'available',
    })
    .select('id')
    .single()
  itemBId = String(itemB!.id)
}

type Probe = { exploited: boolean; error: string | null; id: string | null }

async function probeInsert(
  client: ReturnType<typeof createClient>,
  table: 'menu_categories' | 'menu_subcategories' | 'menu_items',
  row: Record<string, unknown>,
): Promise<Probe> {
  const { data, error } = await client.from(table).insert(row).select('id').maybeSingle()
  const id = data?.id ? String(data.id) : null
  if (id) probeIds.push({ table, id })
  return { exploited: Boolean(id), error: error?.message ?? null, id }
}

async function probeUpdate(
  client: ReturnType<typeof createClient>,
  table: 'menu_categories' | 'menu_subcategories' | 'menu_items',
  id: string,
  updates: Record<string, unknown>,
): Promise<Probe> {
  const { data, error } = await client.from(table).update(updates).eq('id', id).select('id').maybeSingle()
  return { exploited: Boolean(data?.id), error: error?.message ?? null, id: data?.id ? String(data.id) : id }
}

async function probeDelete(
  client: ReturnType<typeof createClient>,
  table: 'menu_categories' | 'menu_subcategories' | 'menu_items',
  id: string,
): Promise<Probe> {
  const { data, error } = await client.from(table).delete().eq('id', id).select('id').maybeSingle()
  return { exploited: !error, error: error?.message ?? null, id: data?.id ? String(data.id) : id }
}

async function cleanup() {
  for (const { table, id } of [...probeIds].reverse()) {
    await dbAdmin.from(table).delete().eq('id', id)
  }
  if (itemAId) await dbAdmin.from('menu_items').delete().eq('id', itemAId)
  if (itemBId) await dbAdmin.from('menu_items').delete().eq('id', itemBId)
  if (subcategoryAId) await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryAId)
  if (subcategoryBId) await dbAdmin.from('menu_subcategories').delete().eq('id', subcategoryBId)
  if (categoryAId) await dbAdmin.from('menu_categories').delete().eq('id', categoryAId)
  if (categoryBId) await dbAdmin.from('menu_categories').delete().eq('id', categoryBId)
  if (ownerAId) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', ownerAId)
    await dbAdmin.from('users').delete().eq('id', ownerAId)
    await authAdmin.auth.admin.deleteUser(ownerAId)
  }
  for (const restId of [restAId, restBId]) {
    if (!restId) continue
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
}

async function main() {
  await setup()
  const ownerClient = await clientForSession(await signIn(ownerAEmail))

  const report = {
    crossTenant_ownerA_to_B: {
      insert_category: await probeInsert(ownerClient, 'menu_categories', {
        restaurant_id: restBId!,
        name: `${tag} xcat`,
        active: true,
        route_to: 'kitchen',
      }),
      update_category: await probeUpdate(ownerClient, 'menu_categories', categoryBId!, {
        name: `${tag} xcat rename`,
      }),
      delete_category: await probeDelete(ownerClient, 'menu_categories', categoryBId!),
      insert_subcategory: await probeInsert(ownerClient, 'menu_subcategories', {
        restaurant_id: restBId!,
        category_id: categoryBId!,
        name: `${tag} xsub`,
      }),
      update_subcategory: await probeUpdate(ownerClient, 'menu_subcategories', subcategoryBId!, {
        name: `${tag} xsub rename`,
      }),
      delete_subcategory: await probeDelete(ownerClient, 'menu_subcategories', subcategoryBId!),
      insert_item: await probeInsert(ownerClient, 'menu_items', {
        restaurant_id: restBId!,
        category_id: categoryBId!,
        subcategory_id: subcategoryBId!,
        name: `${tag} xitem`,
        base_price: 1,
        status: 'available',
      }),
      update_item: await probeUpdate(ownerClient, 'menu_items', itemBId!, {
        name: `${tag} xitem rename`,
      }),
      delete_item: await probeDelete(ownerClient, 'menu_items', itemBId!),
    },
    anonGuestWrites_to_B: {
      insert_category: await probeInsert(anonGuest, 'menu_categories', {
        restaurant_id: restBId!,
        name: `${tag} anon cat`,
        active: true,
        route_to: 'kitchen',
      }),
      update_category: await probeUpdate(anonGuest, 'menu_categories', categoryBId!, {
        name: `${tag} anon rename`,
      }),
      delete_category: await probeDelete(anonGuest, 'menu_categories', categoryBId!),
      insert_subcategory: await probeInsert(anonGuest, 'menu_subcategories', {
        restaurant_id: restBId!,
        category_id: categoryBId!,
        name: `${tag} anon sub`,
      }),
      update_subcategory: await probeUpdate(anonGuest, 'menu_subcategories', subcategoryBId!, {
        name: `${tag} anon sub rename`,
      }),
      delete_subcategory: await probeDelete(anonGuest, 'menu_subcategories', subcategoryBId!),
      insert_item: await probeInsert(anonGuest, 'menu_items', {
        restaurant_id: restBId!,
        category_id: categoryBId!,
        subcategory_id: subcategoryBId!,
        name: `${tag} anon item`,
        base_price: 2,
        status: 'available',
      }),
      update_item: await probeUpdate(anonGuest, 'menu_items', itemBId!, {
        name: `${tag} anon item rename`,
      }),
      delete_item: await probeDelete(anonGuest, 'menu_items', itemBId!),
    },
  }

  console.log(JSON.stringify(report, null, 2))

  const allBlocked = [
    ...Object.values(report.crossTenant_ownerA_to_B),
    ...Object.values(report.anonGuestWrites_to_B),
  ].every((p) => !p.exploited)

  if (!allBlocked) {
    console.error('MENU_TABLES_RLS_PROBES_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('MENU_TABLES_RLS_PROBES_PRODUCTION_OK')
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
