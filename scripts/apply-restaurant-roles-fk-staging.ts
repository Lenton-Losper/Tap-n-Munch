/**
 * Staging: apply Phase 4A composite FK migration.
 *
 * Requires Supabase CLI linked to staging (mdqjpxwczrhkxkbqatqa):
 *   npx supabase link --project-ref mdqjpxwczrhkxkbqatqa
 *   npx tsx scripts/apply-restaurant-roles-fk-staging.ts
 *
 * Or manually:
 *   npx supabase db query --linked -f supabase/migrations/20260705140000_restaurant_roles_composite_fk.sql
 *   npx supabase migration repair --linked --status applied 20260705140000
 */
import { execSync } from 'child_process'
import { config } from 'dotenv'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const MIGRATION = 'supabase/migrations/20260705140000_restaurant_roles_composite_fk.sql'

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase')

function run(cmd: string) {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: process.cwd() })
}

async function main() {
  run(`npx supabase link --project-ref ${STAGING_REF}`)
  run(`npx supabase db query --linked -f ${MIGRATION}`)
  run('npx supabase migration repair --linked --status applied 20260705140000')
  console.log('RESTAURANT_ROLES_FK_STAGING_OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
