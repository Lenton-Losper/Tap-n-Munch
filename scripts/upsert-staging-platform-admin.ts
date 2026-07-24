/**
 * Upsert a staging auth user + public.users + platform_admins (super_admin).
 *
 * Env:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (must be staging mdqjpxwczrhkxkbqatqa)
 *   BOOTSTRAP_EMAIL
 *   BOOTSTRAP_PASSWORD
 *
 * Never logs the password.
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''
const email = (process.env.BOOTSTRAP_EMAIL || '').trim().toLowerCase()
const password = process.env.BOOTSTRAP_PASSWORD || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging Supabase credentials missing or wrong project')
}
if (!email || !password) {
  throw new Error('BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD are required')
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function findUserByEmail(target: string) {
  // Prefer list + filter; paginate a bit for safety
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const found = (data.users || []).find((u) => (u.email || '').toLowerCase() === target)
    if (found) return found
    if ((data.users || []).length < 200) break
  }
  return null
}

async function main() {
  let user = await findUserByEmail(email)
  let created = false

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Lenton Losper' },
    })
    if (error || !data.user) throw error || new Error('createUser failed')
    user = data.user
    created = true
    console.log(`Created auth user ${email} id=${user.id}`)
  } else {
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
    })
    if (error) throw error
    console.log(`Updated password for existing auth user ${email} id=${user.id}`)
  }

  const { error: pubErr } = await admin.from('users').upsert(
    {
      id: user.id,
      email,
      full_name: 'Lenton Losper',
      name: 'Lenton Losper',
      role: 'owner',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )
  if (pubErr) throw pubErr
  console.log('Ensured public.users row')

  const { error: adminErr } = await admin.from('platform_admins').upsert(
    {
      user_id: user.id,
      email,
      role: 'super_admin',
    },
    { onConflict: 'email' },
  )
  if (adminErr) {
    // Fallback if unique is on user_id instead of email
    const { data: existingAdmin } = await admin
      .from('platform_admins')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (existingAdmin?.id) {
      const { error: updErr } = await admin
        .from('platform_admins')
        .update({ email, role: 'super_admin' })
        .eq('id', existingAdmin.id)
      if (updErr) throw updErr
    } else {
      const { error: insErr } = await admin.from('platform_admins').insert({
        user_id: user.id,
        email,
        role: 'super_admin',
      })
      if (insErr) throw insErr
    }
  }
  console.log('Ensured platform_admins super_admin')

  // Verify password works (does not print it)
  const verify = createClient(url, process.env.SUPABASE_ANON_KEY || process.env.STAGING_SUPABASE_ANON_KEY || serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  // Prefer anon if available; service role can still attempt password grant via auth API
  const { error: signErr } = await admin.auth.signInWithPassword({ email, password })
  if (signErr) {
    console.warn('WARN: signInWithPassword verification failed:', signErr.message)
  } else {
    console.log('Verified sign-in works')
    await admin.auth.signOut()
  }

  console.log(`DONE created=${created} user_id=${user.id}`)
  void verify
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exitCode = 1
})
