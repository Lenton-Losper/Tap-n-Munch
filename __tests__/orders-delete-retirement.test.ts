/**
 * `orders:delete` IS RETIRED.
 *
 * ============================================================================================
 * WHY IT WENT
 * ============================================================================================
 *
 * It was defined, seeded onto the owner role in July, carried by 15 role rows on production —
 * and NEVER CHECKED ANYWHERE. Not one `authorize()` call, not one route. A permission nothing
 * enforces does not restrict anything; it only tells whoever reads the staff page that deleting
 * orders is a controlled action, which was false. The real control is `orders:void`, which is
 * enforced at the amend route through the `line_void` purpose.
 *
 * ============================================================================================
 * SEPARATE COMMIT, SEPARATELY REVERTIBLE
 * ============================================================================================
 *
 * Adding orders:void and removing orders:delete are two changes. If the void gate has to be
 * rolled back, the retirement should not come back with it, and vice versa. These tests cover
 * ONLY the removal.
 *
 * ============================================================================================
 * CONDITIONS, NOT MARKER STRINGS
 * ============================================================================================
 *
 * "the constant is gone" is asserted against the exported object, not against the source text —
 * a grep for `ORDERS_DELETE` fails on this file's own prose, and passes on a constant that has
 * merely been renamed. Four defects on 2026-09-05 came from tests that matched a string.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@/lib/permissions'
import { PERMISSION_GROUPS } from '@/lib/restaurant-roles/permission-labels'

const ROOT = join(__dirname, '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const sql = (s: string) => s.replace(/^\s*--.*$/gm, '')

const RETIRED = 'orders:delete'
const REVOKE_MIG = sql(read('supabase', 'migrations', '20260906120300_revoke_orders_delete.sql'))

/** Comments legitimately name the retired value — that documentation is the point. */
const code = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/"\$comment":[^\n]*\n/g, '')

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.open-next') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|json)$/.test(name)) out.push(p)
  }
  return out
}

describe('the constant is gone from the platform definition', () => {
  it('no permission in PERMISSIONS has the retired value', () => {
    // Asserted over VALUES, so renaming the key to something else does not sneak it back.
    expect(Object.values(PERMISSIONS)).not.toContain(RETIRED)
  })

  it('orders:void is what took its place, and it IS defined', () => {
    // A retirement with no replacement would be a removed control, not a corrected one.
    expect(Object.values(PERMISSIONS)).toContain('orders:void')
  })
})

describe('no role grants it any more', () => {
  it('no role in the static config carries it', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect({ role, has: perms.includes(RETIRED as Permission) }).toEqual({ role, has: false })
    }
  })

  it('every permission the config still grants is one the platform defines', () => {
    /**
     * The general condition behind this change: a config entry naming a capability that does not
     * exist grants nothing and looks like it grants something. This catches the next one too.
     */
    const defined = new Set<string>(Object.values(PERMISSIONS))
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      const unknown = perms.filter((p) => !defined.has(p))
      expect({ role, unknown }).toEqual({ role, unknown: [] })
    }
  })
})

describe('it is off the staff page', () => {
  it('no permission group offers it', () => {
    const offered = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key))
    expect(offered).not.toContain(RETIRED)
  })

  it('the Orders group still offers the real control', () => {
    // If the group emptied out instead, nobody could grant a void from the UI.
    const orders = PERMISSION_GROUPS.find((g) => g.domain === 'Orders')
    expect(orders).toBeDefined()
    expect(orders!.permissions.map((p) => p.key)).toContain('orders:void')
  })

  it('every offered permission has real label text', () => {
    for (const group of PERMISSION_GROUPS) {
      for (const p of group.permissions) {
        expect({ key: p.key, labelled: Boolean(p.label && p.description) }).toEqual({
          key: p.key,
          labelled: true,
        })
      }
    }
  })
})

describe('nothing in the tree still writes or checks it', () => {
  it('no source file outside comments names it', () => {
    /**
     * This is the claim the migration makes in prose — that removing the grant breaks no code
     * path — turned into something that fails when it stops being true. Staging fixture scripts
     * counted: they seeded role rows with it, which would have written the grant straight back.
     */
    const offenders: string[] = []
    for (const dir of ['app', 'lib', 'components', 'scripts']) {
      for (const file of walk(join(ROOT, dir))) {
        if (code(readFileSync(file, 'utf8')).includes(RETIRED)) {
          offenders.push(file.slice(ROOT.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the revoke migration', () => {
  it('removes exactly that one value and leaves every other permission alone', () => {
    // array_remove, not a rewrite of the array: a venue's customised roles survive.
    expect(REVOKE_MIG).toMatch(/array_remove\(permissions, 'orders:delete'\)/)
    expect(REVOKE_MIG).not.toMatch(/DELETE\s+FROM/i)
  })

  it('is idempotent — re-running it changes nothing', () => {
    expect(REVOKE_MIG).toMatch(/WHERE permissions @> ARRAY\['orders:delete'\]::text\[\]/)
  })

  it('is scoped to restaurant_roles and touches no other table', () => {
    const statements = REVOKE_MIG.split(';').filter((s) => s.trim())
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/UPDATE public\.restaurant_roles/)
  })

  it('writes data only — no schema change rides along', () => {
    // Ruled 2026-09-02, and enforced by check-migration-no-data-write.mjs from the other side.
    expect(REVOKE_MIG).not.toMatch(/\b(ALTER|CREATE|DROP)\b/i)
  })

  it('runs in both environments', () => {
    // Production is where the 15 rows are; staging needs it to stay comparable.
    expect(read('supabase', 'migrations', '20260906120300_revoke_orders_delete.sql')).toMatch(
      /^-- @env: both$/m
    )
  })
})

describe('history is not rewritten', () => {
  it('the July seed migration still records that it was granted', () => {
    /**
     * The seed is a record of what happened, not a description of what should be true now.
     * Editing it would make the ledger disagree with what the database was actually given, and
     * would silently change nothing on any environment that has already run it.
     */
    const seed = read('supabase', 'migrations', '20260704161000_auth_v2_restaurant_roles_seed.sql')
    expect(seed).toContain(`'${RETIRED}'`)
  })
})
