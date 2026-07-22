import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })
import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: staff } = await admin
    .from('staff_members')
    .select('id')
    .eq('restaurant_id', '01bf27f1-a958-4322-bb3e-cc5240987808')
    .limit(1)
    .maybeSingle()
  console.log('staff', staff)
  const { data, error } = await admin.from('staff_permissions').insert({
    staff_id: staff!.id,
    restaurant_id: '01bf27f1-a958-4322-bb3e-cc5240987808',
    permission: 'analytics:view',
    effect: 'allow',
  })
  console.log('insert', { data, error })
  if (!error) {
    await admin.from('staff_permissions').delete().eq('staff_id', staff!.id).eq('permission', 'analytics:view')
  }
}
main()
