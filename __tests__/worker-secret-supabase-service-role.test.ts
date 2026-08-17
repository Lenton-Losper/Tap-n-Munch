/**
 * Issue #266 — SUPABASE_SERVICE_ROLE_KEY was present on both Cloudflare Workers but absent from
 * both workflows' `wrangler secret put` steps. It had been set out of band, so neither Worker
 * was reproducible from the repo: a fresh Worker, or one whose secrets were ever cleared, would
 * come up without it.
 *
 * Missing is worse than it sounds. createServerSupabaseClient() reads
 *
 *     const key = serviceRoleKey || anonKey
 *
 * (lib/supabase/server.ts) — so an absent service-role key does not fail, it silently downgrades
 * every server route to the public anon role under RLS. That is the exact posture #262 is about,
 * and it would be invisible: no error, no log, just server routes that can suddenly only see
 * what an anonymous browser can. The other three secrets in these steps degrade a feature you
 * would notice (cron 401s, terminal activation fails, invite emails do not send) and so warn;
 * this one fails the job.
 *
 * Neither addition needs a new GitHub secret: production-worker.yml already references
 * `secrets.SUPABASE_SERVICE_ROLE_KEY` for its migration-drift check, and staging.yml already
 * references `secrets.STAGING_SUPABASE_SERVICE_ROLE_KEY` in a dozen places.
 *
 * FAILS WITHOUT THE FIX: neither step mentions SUPABASE_SERVICE_ROLE_KEY at 237caec.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parse } from 'yaml'

const WORKFLOWS = join(__dirname, '..', '.github', 'workflows')

type Step = { name?: string; run?: string; env?: Record<string, string> }
type Job = { steps?: Step[] }
type Workflow = { jobs: Record<string, Job> }

function secretsStep(file: string): Step {
  const wf = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow
  const step = Object.values(wf.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((s) => (s.name ?? '').toLowerCase().includes('set cloudflare worker secrets'))
  if (!step) throw new Error(`no "Set Cloudflare worker secrets" step in ${file}`)
  return step
}

/** Every `secrets.X` this workflow reads anywhere — the proof that X is not a new secret. */
function referencedSecrets(file: string): Set<string> {
  const raw = readFileSync(join(WORKFLOWS, file), 'utf8')
  const names = new Set<string>()
  for (const m of raw.matchAll(/secrets\.([A-Z0-9_]+)/g)) names.add(m[1])
  return names
}

describe.each([
  ['production-worker.yml', 'SUPABASE_SERVICE_ROLE_KEY'],
  ['staging.yml', 'STAGING_SUPABASE_SERVICE_ROLE_KEY'],
])('%s worker secrets are reproducible from the repo (#266)', (file, githubSecret) => {
  it('pushes SUPABASE_SERVICE_ROLE_KEY to the Worker', () => {
    const step = secretsStep(file)
    expect(step.run ?? '').toMatch(/wrangler@[\d.]+ secret put SUPABASE_SERVICE_ROLE_KEY/)
  })

  it(`sources it from secrets.${githubSecret}`, () => {
    const step = secretsStep(file)
    expect(step.env?.SUPABASE_SERVICE_ROLE_KEY).toBe(`\${{ secrets.${githubSecret} }}`)
  })

  it('requires no new GitHub secret — that name is already referenced in this workflow', () => {
    // Counted over the whole file, so the assertion is about the repo's existing configuration
    // and not about the line this change just added.
    const raw = readFileSync(join(WORKFLOWS, file), 'utf8')
    const uses = raw.split(`secrets.${githubSecret} }}`).length - 1
    expect(referencedSecrets(file).has(githubSecret)).toBe(true)
    expect(uses).toBeGreaterThan(1)
  })

  it('FAILS the job when the value is empty rather than warning', () => {
    const run = secretsStep(file).run ?? ''
    // The three feature secrets warn; this one must not, because an anon-key fallback is silent.
    expect(run).toMatch(/if \[ -z "\$SUPABASE_SERVICE_ROLE_KEY" \]/)
    const guard = run.slice(run.indexOf('if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]'))
    expect(guard).toContain('exit 1')
    expect(guard.slice(0, guard.indexOf('exit 1'))).not.toMatch(/^\s*echo "WARNING/m)
  })
})
