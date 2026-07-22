import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })
import { createClient } from '@supabase/supabase-js'

const APP = 'https://www.flashtap.app'
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const { data: ownerRow } = await admin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  const { data: userRow } = await admin.from('users').select('email').eq('id', ownerRow!.user_id).maybeSingle()
  const email = userRow!.email
  console.log('owner email', email)

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const { data: sess, error: otpErr } = await admin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr) throw otpErr
  const token = sess.session!.access_token

  const res = await fetch(`${APP}/api/analytics/orders-summary?restaurantId=${RIVIERA}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  console.log({ status: res.status, orderCount: body.orders?.length, error: body.error })
}
main().catch(console.error)
