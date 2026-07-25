/**
 * Staging cleanup: remove unintended platform_admins row for the kitchen
 * test fixture and reset user_active_context to its restaurant membership.
 *
 *   npx tsx scripts/cleanup-staging-kitchen-platform-admin.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (staging).
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const TARGET_EMAIL = 'staging.kitchen.test@gmail.com'
const TARGET_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325'
const TARGET_ADMIN_ID = '82afbd4f-3d24-4a3b-aa76-155ab2ed569c'
const TARGET_RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

async function main() {
  const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  }
  if (!url.includes(STAGING_REF)) {
    throw new Error(`Refusing: SUPABASE_URL is not staging (${STAGING_REF})`)
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: beforeAdmin, error: beforeAdminErr } = await admin
    .from('platform_admins')
    .select('id, user_id, email, role, created_at')
    .eq('id', TARGET_ADMIN_ID)
    .maybeSingle()
  if (beforeAdminErr) throw beforeAdminErr
  console.log('before_platform_admins', JSON.stringify(beforeAdmin))

  if (beforeAdmin) {
    if (
      beforeAdmin.user_id !== TARGET_USER_ID ||
      (beforeAdmin.email || '').toLowerCase() !== TARGET_EMAIL
    ) {
      throw new Error(
        `Refusing delete: row ${TARGET_ADMIN_ID} does not match kitchen fixture ` +
          `(got user_id=${beforeAdmin.user_id} email=${beforeAdmin.email})`,
      )
    }
    const { error: delErr } = await admin.from('platform_admins').delete().eq('id', TARGET_ADMIN_ID)
    if (delErr) throw delErr
    console.log('deleted_platform_admins', TARGET_ADMIN_ID)
  } else {
    console.log('platform_admins_already_absent', TARGET_ADMIN_ID)
  }

  const { data: membership, error: membershipErr } = await admin
    .from('restaurant_users')
    .select('restaurant_id, role, deleted_at')
    .eq('user_id', TARGET_USER_ID)
    .is('deleted_at', null)
  if (membershipErr) throw membershipErr
  console.log('restaurant_users', JSON.stringify(membership))

  const restaurantId =
    membership?.find((m) => m.restaurant_id === TARGET_RESTAURANT_ID)?.restaurant_id ||
    membership?.[0]?.restaurant_id
  if (!restaurantId) {
    throw new Error('Kitchen fixture has no active restaurant_users row; refusing context reset')
  }

  const { error: ctxErr } = await admin.from('user_active_context').upsert(
    {
      user_id: TARGET_USER_ID,
      context_type: 'restaurant',
      restaurant_id: restaurantId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (ctxErr) throw ctxErr
  console.log('reset_user_active_context', { context_type: 'restaurant', restaurant_id: restaurantId })

  const { data: isAdmin, error: rpcErr } = await admin.rpc('is_platform_admin', {
    p_user_id: TARGET_USER_ID,
  })
  if (rpcErr) throw rpcErr

  const { data: afterAdmin } = await admin
    .from('platform_admins')
    .select('id')
    .eq('user_id', TARGET_USER_ID)
  const { data: afterCtx } = await admin
    .from('user_active_context')
    .select('context_type, restaurant_id')
    .eq('user_id', TARGET_USER_ID)
    .maybeSingle()

  console.log(
    JSON.stringify({
      is_platform_admin: isAdmin,
      platform_admins_rows: afterAdmin?.length ?? 0,
      user_active_context: afterCtx,
    }),
  )
  if (isAdmin === true) throw new Error('is_platform_admin still true after delete')
  console.log('CLEANUP_STAGING_KITCHEN_PLATFORM_ADMIN_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
