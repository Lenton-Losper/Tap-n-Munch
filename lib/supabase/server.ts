import { createClient } from '@supabase/supabase-js'

export function createServerSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url) throw new Error('Missing Supabase URL')

  /**
   * #264. NO SILENT FALLBACK TO THE ANON KEY.
   *
   * This read `const key = serviceRoleKey || anonKey`. Every route under app/api/** calls this
   * constructor to get a PRIVILEGED client, and when `SUPABASE_SERVICE_ROLE_KEY` was absent it
   * quietly substituted the PUBLIC anon key and returned a client the caller could not tell
   * apart. The result is not an outage but something worse to diagnose: reads silently narrowed
   * by RLS and writes silently refused, on a server that believes it is privileged.
   *
   * The anon key is especially available to be picked up by mistake because
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY` is inlined into the bundle at build time, while the
   * service-role key must be present in the Worker's RUNTIME env. So the wrong one is always
   * there and the right one is the one that can go missing.
   *
   * FAILING LOUDLY IS SAFE HERE, and that is measured rather than assumed: both deploy paths set
   * the secret explicitly — production-worker.yml:183 and staging.yml:639 both
   * `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`, and production additionally refuses to
   * deploy when it is empty (production-worker.yml:179). So no live worker relies on the
   * fallback, and removing it cannot lock anything out. It only turns a silent misconfiguration
   * into a startup error that names itself.
   *
   * `anonKey` is deliberately still read above so this message can say whether the thing it
   * would have fallen back to was even present — "missing service-role key" and "missing every
   * credential" are different problems and should not share a sentence.
   */
  if (!serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY. Server routes must not fall back to the public anon key' +
        (anonKey ? ' (the anon key IS present, which is exactly the mistake this guards).' : '.'),
    )
  }

  const key = serviceRoleKey

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
