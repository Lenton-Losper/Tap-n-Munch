/**
 * Issue #262 — the opaque per-tab member key.
 *
 * `tabs.members` is granted to `anon` by
 * supabase/migrations/20260726200000_enable_rls_tabs_restaurants_users_sessions.sql under a
 * policy with no restaurant scope, and it holds every diner's raw `session_id`. A session_id is
 * a credential: lib/guest-orders/queries.ts fetchGuestOrdersBySession reads a diner's orders by
 * it. The two screens that still need the array need a NAME per diner, not the credential, so
 * lib/tab-member-key.ts substitutes a key derived from the service-role secret.
 *
 * Four properties were ruled, and each has its own test below:
 *
 *   1. versioned domain separation — a distinct literal label, so this derivation can never be
 *      made to agree with another use of the same secret, and `:v1` can be bumped to rotate
 *      member keys without touching Supabase credentials;
 *   2. no secret, no keys — throw, with no fallback and no empty-string branch;
 *   3. never persisted — mapped at READ time on both sides, never written to a row;
 *   4. per tab — the same diner in two tabs gets two unrelated keys.
 *
 * FAILS WITHOUT THE FIX: lib/tab-member-key.ts does not exist at 97e4fe1, so every test here
 * fails to resolve its import.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')

const SECRET = 'service-role-secret-under-test'
const OTHER_SECRET = 'a-completely-different-service-role-secret'

const TAB_A = '11111111-1111-4111-8111-111111111111'
const TAB_B = '22222222-2222-4222-8222-222222222222'
const SESSION = 'session_1754900000000_abc123'

/**
 * Loaded fresh per test so the module reads whatever SUPABASE_SERVICE_ROLE_KEY is set at the
 * time. `jest.setup-env.ts` loads a real .env.test, which does define the variable — reading it
 * at import time would make the "throws when absent" test pass for the wrong reason.
 */
function loadModule() {
  let mod!: typeof import('@/lib/tab-member-key')
  jest.isolateModules(() => {
    mod = require('@/lib/tab-member-key')
  })
  return mod
}

const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret
})

describe('tab member key derivation (#262)', () => {
  describe('(1) versioned domain separation', () => {
    it('carries a distinct versioned literal label', () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const { TAB_MEMBER_KEY_DOMAIN } = loadModule()
      expect(TAB_MEMBER_KEY_DOMAIN).toBe('flashtap:tab-member-key:v1')
      // The version suffix is the rotation escape hatch. If it is ever dropped, member keys can
      // no longer be invalidated independently of the Supabase service-role key itself.
      expect(TAB_MEMBER_KEY_DOMAIN).toMatch(/:v\d+$/)
    })

    it('is the HKDF salt, so changing the label changes every key', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const source = readFileSync(join(ROOT, 'lib/tab-member-key.ts'), 'utf8')
      // Pins the label into the derivation itself rather than merely exporting it: a constant
      // that nothing feeds to crypto.subtle separates no domains.
      expect(source).toMatch(/salt:\s*encoder\.encode\(TAB_MEMBER_KEY_DOMAIN\)/)
      expect(source).toMatch(/\$\{TAB_MEMBER_KEY_DOMAIN\}\|\$\{sid\}/)
    })

    it('produces different keys under different secrets', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const withSecret = await loadModule().deriveTabMemberKey(TAB_A, SESSION)

      process.env.SUPABASE_SERVICE_ROLE_KEY = OTHER_SECRET
      const withOther = await loadModule().deriveTabMemberKey(TAB_A, SESSION)

      expect(withSecret).not.toBe(withOther)
    })
  })

  describe('(2) throws when the secret is absent', () => {
    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['whitespace', '   '],
    ])('rejects a %s SUPABASE_SERVICE_ROLE_KEY rather than falling back', async (_label, value) => {
      if (value === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = value

      await expect(loadModule().deriveTabMemberKey(TAB_A, SESSION)).rejects.toThrow(
        /SUPABASE_SERVICE_ROLE_KEY is required/,
      )
    })

    it('has no default, fallback or empty-string branch in the source', () => {
      const source = readFileSync(join(ROOT, 'lib/tab-member-key.ts'), 'utf8')
      const secretRead = /process\.env\.SUPABASE_SERVICE_ROLE_KEY[^\n]*/g
      const reads = source.match(secretRead) ?? []
      expect(reads).toHaveLength(1)
      // `?? ''` normalises undefined for the emptiness check on the very next line; anything
      // that supplies a USABLE default (`|| 'x'`, `?? SOMETHING`) would be the fallback the
      // ruling forbids.
      expect(reads[0]).toContain("?? ''")
      expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*(\|\||\?\?)\s*[^'\s]/)
    })
  })

  describe('(3) never persisted', () => {
    it('the module has no database client and therefore cannot write', () => {
      const source = readFileSync(join(ROOT, 'lib/tab-member-key.ts'), 'utf8')
      // A leaf module with no imports at all — the same discipline lib/tab-status.ts follows,
      // and the reason an API route can use it without dragging in the browser Supabase client.
      expect(source).not.toMatch(/^\s*import\s/m)
      expect(source).not.toContain('supabase')
    })

    it('redactTabMembers does not mutate the stored array it was handed', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const stored = [{ session_id: SESSION, display_name: 'Ana', joined_at: '2026-08-11T10:00:00Z' }]
      const snapshot = JSON.parse(JSON.stringify(stored))

      await loadModule().redactTabMembers(TAB_A, stored)

      // If the mapper edited in place, the caller holding this row could write it straight back.
      expect(stored).toEqual(snapshot)
    })

    it('redactGuestOrderMemberIds does not mutate the rows it was handed', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const rows = [{ id: 'o1', tab_id: TAB_A, member_session_id: SESSION, session_id: SESSION }]
      const snapshot = JSON.parse(JSON.stringify(rows))

      const out = await loadModule().redactGuestOrderMemberIds(rows)

      expect(rows).toEqual(snapshot)
      expect(out[0]).not.toBe(rows[0])
      expect(out[0].member_session_id).toMatch(/^mk_/)
    })

    it('no source file sends a derived key into an insert/update/upsert payload', () => {
      const offenders: string[] = []
      for (const file of sourceFiles()) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(/\.(insert|update|upsert)\(/g)) {
          const window = source.slice(match.index ?? 0, (match.index ?? 0) + 400)
          if (/member_key|mk_/.test(window)) offenders.push(`${file}: ${match[0]}`)
        }
      }
      // The rows keep holding real session ids. Both sides map on the way OUT; a write that
      // stored a derived key would freeze it against the current secret and break the moment
      // the `:v1` label was ever bumped.
      expect(offenders).toEqual([])
    })
  })

  describe('(4) per tab', () => {
    it('gives the same customer two different keys in two different tabs', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const mod = loadModule()

      const inTabA = await mod.deriveTabMemberKey(TAB_A, SESSION)
      const inTabB = await mod.deriveTabMemberKey(TAB_B, SESSION)

      expect(inTabA).toMatch(/^mk_[0-9a-f]{32}$/)
      expect(inTabB).toMatch(/^mk_[0-9a-f]{32}$/)
      // The whole point: a key harvested from one tab identifies nobody on any other tab.
      expect(inTabA).not.toBe(inTabB)
    })

    it('is stable for the same (tab, session) pair, or the join would not resolve', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const mod = loadModule()
      expect(await mod.deriveTabMemberKey(TAB_A, SESSION)).toBe(
        await mod.deriveTabMemberKey(TAB_A, SESSION),
      )
    })

    it('separates two customers within one tab', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const mod = loadModule()
      expect(await mod.deriveTabMemberKey(TAB_A, 'session_one')).not.toBe(
        await mod.deriveTabMemberKey(TAB_A, 'session_two'),
      )
    })

    it('refuses to derive without a tab id, rather than sharing one key across tabs', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      await expect(loadModule().deriveTabMemberKey('  ', SESSION)).rejects.toThrow(/tab id/)
    })
  })

  describe('the two sides agree', () => {
    it('a member key and the matching order member_session_id come out identical', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const mod = loadModule()

      const [member] = await mod.redactTabMembers(TAB_A, [
        { session_id: SESSION, display_name: 'Ana', joined_at: '2026-08-11T10:00:00Z' },
      ])
      const [order] = await mod.redactGuestOrderMemberIds([
        { id: 'o1', tab_id: TAB_A, member_session_id: SESSION },
      ])

      // This equality IS the feature. app/menu/[restaurantId]/tab/page.tsx and
      // .../receipt/page.tsx both join on it to print a diner's name against that diner's lines.
      expect(member.member_key).toBe(order.member_session_id)
      expect(member).toEqual({
        display_name: 'Ana',
        joined_at: '2026-08-11T10:00:00Z',
        member_key: member.member_key,
      })
      // Whitelist, not blacklist: a column added to the members JSONB later must not ride out.
      expect(Object.keys(member).sort()).toEqual(['display_name', 'joined_at', 'member_key'])
      expect(JSON.stringify(member)).not.toContain(SESSION)
    })

    it('falls back to session_id so orders predating member_session_id still pair up', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const mod = loadModule()

      const [member] = await mod.redactTabMembers(TAB_A, [
        { session_id: SESSION, display_name: 'Ana' },
      ])
      const [order] = await mod.redactGuestOrderMemberIds([
        { id: 'o1', tab_id: TAB_A, member_session_id: null, session_id: SESSION },
      ])

      // The two screens read `o.member_session_id || o.session_id`; leaving a null row alone
      // would have dropped exactly those orders out of their member's group.
      expect(order.member_session_id).toBe(member.member_key)
    })

    it('leaves an order with no tab alone — there is no per-tab key to derive', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const [order] = await loadModule().redactGuestOrderMemberIds([
        { id: 'o1', tab_id: null, member_session_id: SESSION, session_id: SESSION },
      ])
      expect(order.member_session_id).toBe(SESSION)
    })

    it('gives a member row with no session_id no key, rather than colliding them all', async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
      const members = await loadModule().redactTabMembers(TAB_A, [
        { display_name: 'Ghost' },
        { session_id: '', display_name: 'Also ghost' },
      ])
      expect(members.map((m) => m.member_key)).toEqual(['', ''])
    })
  })
})

/** Every first-party .ts/.tsx source file (no node_modules, no build output). */
function sourceFiles(): string[] {
  const roots = ['app', 'lib', 'contexts', 'hooks', 'components']
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (/\.tsx?$/.test(entry)) {
        found.push(full)
      }
    }
  }
  for (const root of roots) walk(join(ROOT, root))
  return found
}
