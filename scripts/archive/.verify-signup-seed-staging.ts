/**
 * Throwaway — verify signup seeds restaurant_roles on staging.
 * npx tsx scripts/.verify-signup-seed-staging.ts
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const BASE = 'https://flashtap-staging.llosperofficial.workers.dev'
const ts = Date.now()
const email = `flashtap.signup.e2e.${ts}@gmail.com`
const password = 'TestSignup1!'
const body = {
  fullName: 'Signup E2E Test',
  email,
  password,
  restaurantName: `E2E Signup Restaurant ${ts}`,
  phone: '+264811234567',
}

const expectedRoles = Object.fromEntries(
  Object.entries(rolePermissionsConfig)
    .filter(([k]) => !k.startsWith('$comment'))
    .map(([role, perms]) => [role, [...(perms as string[])].sort()]),
)

async function main() {
  console.log('=== Path 1: POST /api/auth/signup ===')
  console.log('Request:', JSON.stringify({ ...body, password: '***' }, null, 2))

  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = { raw: text }
  }
  console.log('Response status:', res.status)
  console.log('Response body:', JSON.stringify(json, null, 2))

  if (!res.ok) process.exit(1)
  const restaurantId = String(json.restaurantId || '')
  if (!restaurantId) {
    console.error('Missing restaurantId')
    process.exit(1)
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: roles, error: rolesErr } = await supabase
    .from('restaurant_roles')
    .select('role_slug, display_name, permissions, is_system')
    .eq('restaurant_id', restaurantId)
    .order('role_slug')

  console.log('\n=== restaurant_roles query ===')
  if (rolesErr) {
    console.error(rolesErr)
    process.exit(1)
  }
  console.log(JSON.stringify(roles, null, 2))

  const slugs = (roles ?? []).map((r) => r.role_slug).sort()
  const expectedSlugs = Object.keys(expectedRoles).sort()
  console.log('\nRole slugs found:', slugs.join(', '))
  console.log('Role slugs expected:', expectedSlugs.join(', '))

  let rolesOk =
    slugs.length === 6 && slugs.every((s, i) => s === expectedSlugs[i])
  for (const row of roles ?? []) {
    const perms = [...(row.permissions as string[])].sort()
    const exp = expectedRoles[row.role_slug as string]
    const match =
      exp && perms.length > 0 && JSON.stringify(perms) === JSON.stringify(exp)
    console.log(
      `permissions match for ${row.role_slug}:`,
      match ? 'YES' : 'NO',
      `(count=${perms.length})`,
    )
    if (!match) rolesOk = false
  }

  const { data: ru, error: ruErr } = await supabase
    .from('restaurant_users')
    .select('restaurant_id, user_id, role')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  console.log('\n=== restaurant_users query ===')
  if (ruErr) {
    console.error(ruErr)
    process.exit(1)
  }
  console.log(JSON.stringify(ru, null, 2))
  console.log(
    '\nrestaurant_users owner row OK:',
    ru?.role === 'owner' ? 'YES' : 'NO',
  )

  console.log('\n=== SUMMARY ===')
  console.log('Signup HTTP 200:', res.status === 200 ? 'PASS' : 'FAIL')
  console.log('restaurantId present:', restaurantId ? 'PASS' : 'FAIL')
  console.log(
    'All 6 roles seeded with matching permissions:',
    rolesOk ? 'PASS' : 'FAIL',
  )
  console.log('restaurant_users role=owner:', ru?.role === 'owner' ? 'PASS' : 'FAIL')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
