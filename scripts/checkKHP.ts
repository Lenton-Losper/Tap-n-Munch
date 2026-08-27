/**
 * READ-ONLY: look up the KHP owner account by email.
 *
 * The production `service_role` key was a string literal in this file until 2026-08-27. It now
 * comes from the environment via scripts/lib/require-service-role-client.ts, which stops if the
 * variable is absent rather than continuing with an empty key. See that file for the reasoning.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/checkKHP.ts
 */
import { requireServiceRoleClient } from './lib/require-service-role-client'

const EMAIL = 'flashtapapp2@gmail.com'

const { client: supabase, environment, projectRef } = requireServiceRoleClient()

async function check() {
  console.log(`checkKHP: reading from ${environment} (${projectRef})`)

  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', EMAIL)

  console.log('Users found:', users)
  console.log('Error:', error)
}

check().catch(console.error)
