/**
 * Shared guard for every production script. READ-ONLY by construction: it hands back a client and a
 * confirmation flag, and nothing else.
 *
 * The guard is INVERTED relative to the staging scripts, deliberately. A staging script refuses
 * unless the URL contains the staging ref; these refuse unless it contains the PRODUCTION ref. Those
 * are different mistakes — running a production delete against staging destroys test data nobody
 * misses, running a staging seed against production does not bear thinking about — and both are
 * worth a hard stop.
 *
 * No dotenv here. These read the ENVIRONMENT, so the operator can see exactly what they set. Loading
 * a .env file would let a stale staging value win silently, which is precisely how a script ends up
 * reporting confidently about the wrong database.
 */
import { createClient } from '@supabase/supabase-js'

export const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
export const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'

export type Guarded = {
  db: ReturnType<typeof createClient>
  url: string
  confirmed: boolean
}

/**
 * @param intent  printed before anything happens, so the operator sees the plan first.
 * @param writes  true for the two scripts that change data; they additionally require --confirm.
 */
export function guard(intent: string[], writes = false): Guarded {
  const url = (process.env.SUPABASE_URL || '').trim()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const confirmed = process.argv.includes('--confirm')

  console.log('='.repeat(78))
  console.log(writes ? 'THIS SCRIPT WRITES TO PRODUCTION' : 'READ ONLY — this script issues only SELECTs')
  console.log('='.repeat(78))
  for (const line of intent) console.log('  ' + line)
  console.log('')

  if (!url || !key) {
    console.error('REFUSING: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.')
    process.exit(1)
  }
  if (url.includes(STAGING_REF)) {
    console.error(`REFUSING: SUPABASE_URL is STAGING (${STAGING_REF}). These scripts are for production.`)
    process.exit(1)
  }
  if (!url.includes(PRODUCTION_REF)) {
    console.error(`REFUSING: SUPABASE_URL does not contain the production ref ${PRODUCTION_REF}.`)
    console.error(`  got: ${url}`)
    process.exit(1)
  }

  console.log(`connected to: ${url}`)
  if (writes && !confirmed) {
    console.log('')
    console.log('DRY RUN. Nothing will be written.')
    console.log('Re-run with --confirm to apply, AFTER reading the preconditions below.')
  }
  console.log('')

  return { db: createClient(url, key, { auth: { persistSession: false } }), url, confirmed }
}

/** Page every read. A count that silently stops at 1000 is a wrong count, and these decide a delete. */
export async function all<T = Record<string, unknown>>(
  q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}
