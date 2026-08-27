/**
 * A SERVICE-ROLE SUPABASE CLIENT BUILT FROM THE ENVIRONMENT, OR A LOUD FAILURE.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * `scripts/checkKHP.ts`, `scripts/onboardKHP.ts` and `scripts/fixRLS.ts` each embedded the SAME
 * production `service_role` JWT as a string literal, in tracked files. A service-role key bypasses
 * RLS entirely, so each of those three lines was a full-database credential sitting in the repo.
 *
 * They are converted to read from the environment on 2026-08-27. That does not undo the exposure of
 * the key already committed -- nothing in this file pretends otherwise, and the decision about the
 * existing key is not this file's to make. What it does is stop the pattern SPREADING: the next
 * one-off script gets written by copying one of these three, and until now what it copied was a
 * literal.
 *
 * ============================================================================================
 * WHY A SHARED HELPER RATHER THAN THREE COPIES
 * ============================================================================================
 *
 * Three copies is how there came to be three literals. A single entry point means the next script
 * copies a `requireServiceRoleClient()` call, and there is no key in view to copy.
 *
 * ============================================================================================
 * IT FAILS LOUDLY, WHICH IS THE POINT
 * ============================================================================================
 *
 * The sibling `scripts/check-duplicate-table-numbers-readonly.ts` does
 *
 *     createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', ...)
 *
 * and that `|| ''` is deliberately NOT copied here. An empty key produces a client that builds
 * fine and fails per-request, so the script runs, prints errors that look like data problems, and
 * exits however it happens to exit. A missing credential must stop the script before it does
 * anything, with a message naming the variable.
 *
 * NOTHING HERE PRINTS A KEY -- not on success, not in any error, not in a debug line. The failure
 * messages name the VARIABLE that is missing and never its value, and the success line names the
 * environment by project ref, which is not a secret.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** The two projects this repo talks to. An unrecognised ref is refused rather than guessed at. */
const PROJECT_REFS: Record<string, string> = {
  ihlmmpmolnpchzgwyhgh: 'PRODUCTION',
  mdqjpxwczrhkxkbqatqa: 'staging',
}

function fail(message: string): never {
  console.error(`\n${message}\n`)
  console.error(
    'Set the variables in your shell or in a .env file, e.g.\n' +
      '    SUPABASE_URL=https://<project-ref>.supabase.co\n' +
      '    SUPABASE_SERVICE_ROLE_KEY=<the service role key>\n\n' +
      'The key is NOT stored in this repository and must not be added to it. A service_role key\n' +
      'bypasses row-level security completely.\n',
  )
  process.exit(1)
}

/** Read a required variable, or stop. Never echoes the value. */
export function requireEnv(name: string, alternates: string[] = []): string {
  for (const key of [name, ...alternates]) {
    const value = process.env[key]
    if (value && value.trim()) return value.trim()
  }
  const names = [name, ...alternates].join(' or ')
  return fail(`MISSING CREDENTIAL: ${names} is not set.`)
}

export type ServiceRoleContext = {
  client: SupabaseClient
  /** 'PRODUCTION' or 'staging'. */
  environment: string
  projectRef: string
}

/**
 * Build a service-role client from the environment.
 *
 * @param opts.requireEnvironment refuse to run unless the resolved project is this one. A
 *   destructive script should pass it, so pointing the shell at the wrong project is an abort
 *   rather than a surprise.
 */
export function requireServiceRoleClient(opts: { requireEnvironment?: string } = {}): ServiceRoleContext {
  const url = requireEnv('SUPABASE_URL', ['NEXT_PUBLIC_SUPABASE_URL'])
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  const projectRef = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? ''
  const environment = PROJECT_REFS[projectRef]
  if (!environment) {
    fail(`UNRECOGNISED PROJECT: SUPABASE_URL points at "${projectRef || '(no ref found)'}".`)
  }

  if (opts.requireEnvironment && environment !== opts.requireEnvironment) {
    fail(
      `WRONG ENVIRONMENT: this script requires ${opts.requireEnvironment}, but SUPABASE_URL ` +
        `points at ${environment} (${projectRef}).`,
    )
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return { client, environment, projectRef }
}
