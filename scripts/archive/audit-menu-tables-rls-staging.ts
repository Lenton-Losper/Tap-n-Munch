/**
 * Step 1 audit: menu_categories / menu_subcategories / menu_items RLS + live write probes.
 *   npx tsx scripts/audit-menu-tables-rls-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
// Depth is `../../`: this file lives in scripts/archive/, and scripts/lib/ holds only
// safe-supabase-linked.ts. The `../lib/...` form used elsewhere in scripts/archive/ resolves to
// scripts/lib/ and does not exist — those files were moved into archive/ without their imports
// being updated, and `scripts/archive/**` is excluded from tsconfig so tsc never reported it.
import { rolePermissionConfigEntries } from '../../lib/permissions/role-permissions-config'
import { probeTable, type ProbeableClient } from '../../lib/supabase/table-exists'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const E2E_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const tag = `menu-rls-audit-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase')

const TABLES = ['menu_categories', 'menu_subcategories', 'menu_items'] as const

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
    full_name: 'Menu RLS audit owner A',
  })
  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: restAId!,
    user_id: ownerAId,
    role: 'owner',
    invite_accepted: true,
  })

  const { data: catA, error: catAErr } = await dbAdmin
    .from('menu_categories')
    .insert({
      restaurant_id: restAId!,
      name: `${tag} Cat A`,
      active: true,
      route_to: 'kitchen',
    })
    .select('id')
    .single()
  if (catAErr || !catA?.id) throw catAErr
  categoryAId = String(catA.id)

  const { data: catB, error: catBErr } = await dbAdmin
    .from('menu_categories')
    .insert({
      restaurant_id: restBId!,
      name: `${tag} Cat B`,
      active: true,
      route_to: 'kitchen',
    })
    .select('id')
    .single()
  if (catBErr || !catB?.id) throw catBErr
  categoryBId = String(catB.id)

  const { data: subA, error: subAErr } = await dbAdmin
    .from('menu_subcategories')
    .insert({
      restaurant_id: restAId!,
      category_id: categoryAId,
      name: `${tag} Sub A`,
    })
    .select('id')
    .single()
  if (subAErr || !subA?.id) throw subAErr
  subcategoryAId = String(subA.id)

  const { data: subB, error: subBErr } = await dbAdmin
    .from('menu_subcategories')
    .insert({
      restaurant_id: restBId!,
      category_id: categoryBId,
      name: `${tag} Sub B`,
    })
    .select('id')
    .single()
  if (subBErr || !subB?.id) throw subBErr
  subcategoryBId = String(subB.id)

  const { data: itemA, error: itemAErr } = await dbAdmin
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
  if (itemAErr || !itemA?.id) throw itemAErr
  itemAId = String(itemA.id)

  const { data: itemB, error: itemBErr } = await dbAdmin
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
  if (itemBErr || !itemB?.id) throw itemBErr
  itemBId = String(itemB.id)
}

async function fetchPolicyCatalog() {
  const { data, error } = await dbAdmin.rpc('exec_sql', {
    query: `
      SELECT
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        p.polname AS policy_name,
        p.polcmd AS command,
        pg_get_expr(p.polqual, p.polrelid) AS using_expr,
        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr,
        ARRAY(
          SELECT rolname FROM pg_roles r WHERE r.oid = ANY(p.polroles)
        ) AS roles
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relname = ANY(ARRAY['menu_categories','menu_subcategories','menu_items'])
      ORDER BY c.relname, p.polname;
    `,
  })

  if (error) {
    const { data: policies, error: polErr } = await dbAdmin
      .from('pg_policies' as 'restaurants')
      .select('*')
    void policies
    if (polErr) {
      return fetchPolicyCatalogViaRest()
    }
  }
  return data
}

async function fetchPolicyCatalogViaRest() {
  const sql = `
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('menu_categories','menu_subcategories','menu_items')
    ORDER BY tablename, policyname;
  `
  const res = await fetch(`${url}/rest/v1/rpc/`, { method: 'POST' })
  void res

  const { data: tableMeta, error: metaErr } = await dbAdmin
    .schema('pg_catalog' as never)
    .from('pg_class' as never)
    .select('*')
    .limit(1)
  void tableMeta
  if (metaErr) {
    /* fall through */
  }

  // #169: this was `.select('*', { count: 'exact', head: true })` reading `!error` as "the table
  // is reachable". That form returns no error for a table that does not exist, so every absent
  // table reported as reachable. probeTable drops `head` so PGRST205 actually surfaces.
  const report: Record<string, unknown> = {}
  for (const table of TABLES) {
    const probe = await probeTable(dbAdmin as unknown as ProbeableClient, table)
    report[table] = {
      exists: probe.exists,
      inconclusive: probe.inconclusive,
      code: probe.code,
      error: probe.message || null,
      rowCount: probe.count,
    }
  }

  const grantsSql = `
    SELECT grantee, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('menu_categories','menu_subcategories','menu_items')
      AND grantee IN ('anon','authenticated','service_role')
    ORDER BY table_name, grantee, privilege_type;
  `

  return {
    note: 'pg_policies direct query unavailable via client; using SQL through admin connection below',
    headProbe: report,
    grantsSql,
  }
}

async function querySql<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const { data, error } = await dbAdmin.rpc('exec_sql' as never, { query: sql } as never)
  if (!error && Array.isArray(data)) return data as T[]

  const pgUrl = url.replace(/\/$/, '')
  const res = await fetch(`${pgUrl}/pg`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (res.ok) {
    const body = await res.json()
    if (Array.isArray(body)) return body as T[]
  }

  const { Postgres } = await import('postgres')
  const conn =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.STAGING_DATABASE_URL
  if (!conn) {
    throw new Error(`Cannot run SQL audit: ${error?.message ?? 'no DATABASE_URL'}`)
  }
  const sqlClient = Postgres(conn, { max: 1 })
  try {
    return (await sqlClient.unsafe(sql)) as T[]
  } finally {
    await sqlClient.end({ timeout: 5 })
  }
}

async function loadCatalog() {
  const policies = await querySql<{
    tablename: string
    policyname: string
    cmd: string
    roles: string[]
    qual: string | null
    with_check: string | null
  }>(`
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('menu_categories','menu_subcategories','menu_items')
    ORDER BY tablename, policyname;
  `)

  const rlsFlags = await querySql<{
    table_name: string
    rls_enabled: boolean
    rls_forced: boolean
  }>(`
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('menu_categories','menu_subcategories','menu_items')
    ORDER BY c.relname;
  `)

  const grants = await querySql<{
    grantee: string
    table_name: string
    privilege_type: string
  }>(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('menu_categories','menu_subcategories','menu_items')
      AND grantee IN ('anon','authenticated','service_role')
    ORDER BY table_name, grantee, privilege_type;
  `)

  return { policies, rlsFlags, grants }
}

type ProbeResult = {
  ok: boolean
  error: string | null
  id: string | null
}

async function probeInsert(
  client: ReturnType<typeof createClient>,
  table: (typeof TABLES)[number],
  row: Record<string, unknown>,
): Promise<ProbeResult> {
  const { data, error } = await client.from(table).insert(row).select('id').maybeSingle()
  const id = data?.id ? String(data.id) : null
  if (id) probeIds.push({ table, id })
  return { ok: !error && Boolean(id), error: error?.message ?? null, id }
}

async function probeUpdate(
  client: ReturnType<typeof createClient>,
  table: (typeof TABLES)[number],
  id: string,
  updates: Record<string, unknown>,
): Promise<ProbeResult> {
  const { data, error } = await client.from(table).update(updates).eq('id', id).select('id').maybeSingle()
  return {
    ok: !error && Boolean(data?.id),
    error: error?.message ?? null,
    id: data?.id ? String(data.id) : id,
  }
}

async function probeDelete(
  client: ReturnType<typeof createClient>,
  table: (typeof TABLES)[number],
  id: string,
): Promise<ProbeResult> {
  const { error } = await client.from(table).delete().eq('id', id)
  return { ok: !error, error: error?.message ?? null, id }
}

async function probeSelect(
  client: ReturnType<typeof createClient>,
  table: (typeof TABLES)[number],
  restaurantId: string,
): Promise<{ ok: boolean; count: number; error: string | null }> {
  const { data, error } = await client
    .from(table)
    .select('id')
    .eq('restaurant_id', restaurantId)
    .limit(5)
  return { ok: !error, count: data?.length ?? 0, error: error?.message ?? null }
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
  const catalog = await loadCatalog()

  const ownerSession = await signIn(ownerAEmail)
  const ownerClient = await clientForSession(ownerSession)

  const liveProbes = {
    guestSelect: {
      menu_categories: await probeSelect(anonGuest, 'menu_categories', restBId!),
      menu_subcategories: await probeSelect(anonGuest, 'menu_subcategories', restBId!),
      menu_items: await probeSelect(anonGuest, 'menu_items', restBId!),
      e2eRestaurant_items: await probeSelect(anonGuest, 'menu_items', E2E_RESTAURANT_ID),
    },
    ownerOwnRestaurantSelect: {
      menu_categories: await probeSelect(ownerClient, 'menu_categories', restAId!),
      menu_subcategories: await probeSelect(ownerClient, 'menu_subcategories', restAId!),
      menu_items: await probeSelect(ownerClient, 'menu_items', restAId!),
    },
    crossTenantWrites_ownerA_to_B: {
      insert_category: await probeInsert(ownerClient, 'menu_categories', {
        restaurant_id: restBId!,
        name: `${tag} hijack cat`,
        active: true,
        route_to: 'kitchen',
      }),
      update_category: await probeUpdate(ownerClient, 'menu_categories', categoryBId!, {
        name: `${tag} hijack cat rename`,
      }),
      delete_category: await probeDelete(ownerClient, 'menu_categories', categoryBId!),
      insert_subcategory: await probeInsert(ownerClient, 'menu_subcategories', {
        restaurant_id: restBId!,
        category_id: categoryBId!,
        name: `${tag} hijack sub`,
      }),
      update_subcategory: await probeUpdate(ownerClient, 'menu_subcategories', subcategoryBId!, {
        name: `${tag} hijack sub rename`,
      }),
      delete_subcategory: await probeDelete(ownerClient, 'menu_subcategories', subcategoryBId!),
      insert_item: await probeInsert(ownerClient, 'menu_items', {
        restaurant_id: restBId!,
        category_id: categoryBId!,
        subcategory_id: subcategoryBId!,
        name: `${tag} hijack item`,
        base_price: 1,
        status: 'available',
      }),
      update_item: await probeUpdate(ownerClient, 'menu_items', itemBId!, {
        name: `${tag} hijack item rename`,
      }),
      delete_item: await probeDelete(ownerClient, 'menu_items', itemBId!),
    },
    anonGuestWrites: {
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
    },
  }

  const report = {
    environment: 'staging',
    supabaseRef: STAGING_REF,
    catalog,
    liveProbes,
    interpretation: {
      select:
        'Public SELECT policies (USING true) should allow guest reads when RLS is enabled; table GRANTs also grant SELECT to anon.',
      writes:
        'If rls_enabled=false, GRANT ALL on anon/authenticated allows unrestricted writes regardless of policies.',
      crossTenant:
        'ownerA_to_B probes use authenticated owner of restaurant A targeting restaurant B rows/disposable inserts.',
    },
  }

  console.log(JSON.stringify(report, null, 2))
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
