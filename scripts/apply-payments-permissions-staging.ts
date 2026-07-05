import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
if (!url.includes('mdqjpxwczrhkxkbqatqa')) throw new Error('not staging')

const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: owners, error } = await admin
    .from('restaurant_roles')
    .select('id, restaurant_id, permissions')
    .eq('role_slug', 'owner')
  if (error) throw error

  let updated = 0
  for (const row of owners ?? []) {
    const perms = [...((row.permissions as string[]) ?? [])]
    let changed = false
    if (!perms.includes('payments:view')) {
      perms.push('payments:view')
      changed = true
    }
    if (!perms.includes('payments:configure')) {
      perms.push('payments:configure')
      changed = true
    }
    if (changed) {
      const { error: uerr } = await admin
        .from('restaurant_roles')
        .update({ permissions: perms })
        .eq('id', row.id)
      if (uerr) throw uerr
      updated++
    }
  }

  const { data: all } = await admin.from('restaurant_roles').select('role_slug, permissions')
  let nonOwner = 0
  for (const r of all ?? []) {
    const p = (r.permissions as string[]) ?? []
    if (
      r.role_slug !== 'owner' &&
      (p.includes('payments:view') || p.includes('payments:configure'))
    ) {
      nonOwner++
    }
  }

  console.log(JSON.stringify({ ownerRows: owners?.length, updated, nonOwnerWithPayments: nonOwner }))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
