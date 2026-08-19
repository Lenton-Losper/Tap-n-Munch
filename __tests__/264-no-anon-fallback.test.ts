/**
 * #264 — a server route must never get a client built on the PUBLIC anon key.
 *
 * `createServerSupabaseClient()` is what every app/api/** route calls for a privileged client. It
 * read `serviceRoleKey || anonKey`, so a missing service-role key produced a client that looked
 * identical to the caller while being silently narrowed by RLS: reads returning less than they
 * should and writes refused, on a server that believes it is privileged.
 *
 * The anon key is the one always available — `NEXT_PUBLIC_SUPABASE_ANON_KEY` is inlined into the
 * bundle at build time, while the service-role key must be in the Worker's runtime env. So the
 * wrong credential is the one that is always there.
 */
export {} // module scope: without this the file shares globals with other specs and  collides

const REAL_ENV = { ...process.env }

beforeEach(() => {
  jest.resetModules()
  process.env = { ...REAL_ENV }
})

afterAll(() => {
  process.env = REAL_ENV
})

const loadServerModule = () => require('@/lib/supabase/server') as typeof import('@/lib/supabase/server')

describe('createServerSupabaseClient', () => {
  it('REFUSES when the service-role key is missing but the anon key is present — the defect', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    expect(() => loadServerModule().createServerSupabaseClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('says the anon key was present, because that is the mistake being guarded', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    expect(() => loadServerModule().createServerSupabaseClient()).toThrow(/anon key IS present/)
  })

  it('SUCCEEDS with a service-role key — the control, or "throws always" would pass the above', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'

    expect(() => loadServerModule().createServerSupabaseClient()).not.toThrow()
  })

  it('still refuses with NO credentials at all, and does not blame the anon key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    expect(() => loadServerModule().createServerSupabaseClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(() => loadServerModule().createServerSupabaseClient()).not.toThrow(/anon key IS present/)
  })

  it('still refuses with no URL', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    expect(() => loadServerModule().createServerSupabaseClient()).toThrow(/Supabase URL/)
  })
})

describe('the deploy paths that make failing loudly safe', () => {
  /**
   * Removing a fallback is only safe if no live worker depends on it. Both deploy paths set the
   * secret explicitly, and production refuses to deploy when it is empty — asserted here so that
   * deleting either step fails this test rather than silently re-arming the defect.
   */
  const { readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('production puts the secret on the worker', () => {
    expect(read('.github/workflows/production-worker.yml')).toMatch(
      /secret put SUPABASE_SERVICE_ROLE_KEY/,
    )
  })

  it('production refuses to deploy when it is empty', () => {
    expect(read('.github/workflows/production-worker.yml')).toMatch(
      /if \[ -z "\$SUPABASE_SERVICE_ROLE_KEY" \]/,
    )
  })

  it('staging puts it too', () => {
    expect(read('.github/workflows/staging.yml')).toMatch(/secret put SUPABASE_SERVICE_ROLE_KEY/)
  })
})
