import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
if (!url.includes('mdqjpxwczrhkxkbqatqa')) throw new Error('not staging')

const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: managers, error } = await admin
    .from('restaurant_roles')
    .select('id, restaurant_id, permissions')
    .eq('role_slug', 'manager')
  if (error) throw error

  let updated = 0
  for (const row of managers ?? []) {
    const perms = [...((row.permissions as string[]) ?? [])]
    if (!perms.includes('settings:write')) {
      perms.push('settings:write')
      const { error: uerr } = await admin
        .from('restaurant_roles')
        .update({ permissions: perms })
        .eq('id', row.id)
      if (uerr) throw uerr
      updated++
    }
  }

  console.log(JSON.stringify({ managerRows: managers?.length, updated }))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
