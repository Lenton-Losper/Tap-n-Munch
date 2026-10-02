/**
 * F19 REMOVED (owner decision 2026-10-03): a valid activation code is sufficient to register a
 * physical terminal to the code's restaurant, wherever the device was registered before.
 *
 * These are SOURCE-LEVEL guards, because the policy this forbids is exactly the kind that comes back
 * by a well-meaning edit ("surely a device shouldn't move between restaurants silently"). The
 * behaviour itself is pinned in terminals-activate-reactivation.test.ts and, for the SQL, by the
 * staging proof; these fail the build if the vocabulary or the shape of the old policy reappears.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const FORBIDDEN = [
  'DEVICE_REGISTERED_ELSEWHERE',
  'DEVICE_TRANSFER_CONFLICT',
  'TRANSFER_NOT_APPROVED',
  'TRANSFER_SAME_RESTAURANT',
  'transfer_terminal_device',
  'transfer_request_device_id',
  'transfer_requested_at',
  'transfer_approved_at',
  'transfer_approved_by',
  'reject_cross_restaurant',
  'resolveActivationTarget',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (['node_modules', '.next', '.open-next', '.git', '.deploy'].includes(name)) continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx|sql)$/.test(name)) out.push(rel)
  }
  return out
}

describe('the cross-restaurant activation policy is gone from the runtime', () => {
  const runtime = ['app', 'lib', 'components', 'hooks', 'contexts'].filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(d))

  it.each(FORBIDDEN)('no runtime source mentions %s', (word) => {
    const hits = runtime.filter((f) => read(f).includes(word))
    expect(hits).toEqual([])
  })

  it('the Devices console, its routes and its library are deleted, not hidden', () => {
    for (const p of ['components/devices', 'lib/devices', 'app/api/admin/devices', 'lib/terminals/resolve-activation-target.ts']) {
      expect(existsSync(join(ROOT, p))).toBe(false)
    }
  })

  it('nothing links to a Devices page or imports the removed modules', () => {
    const hits = runtime.filter((f) => /components\/devices|lib\/devices|admin\/devices|devices-console/.test(read(f)))
    expect(hits).toEqual([])
  })

  it('the activation route has no branch that refuses on device ownership', () => {
    const src = read('app/api/terminals/activate/route.ts')
    // The only 409 left is the retryable race conflict; there is no ownership refusal.
    expect(src).not.toMatch(/status:\s*409[\s\S]{0,200}(another restaurant|elsewhere|registered to)/i)
    expect(src).not.toMatch(/holders|supersededTerminalId|\.in\('device_id'|\.in\(column/)
    expect(src).toContain("rpc('activate_terminal_by_code'")
  })
})

describe('activate_terminal_by_code keeps the one-owner invariant in SQL', () => {
  const sql = read('supabase/migrations/20261003100000_activate_terminal_by_code.sql')
  const body = sql.slice(sql.indexOf('AS $$'))

  it('releases the other holders BEFORE binding the target', () => {
    expect(body.indexOf("status = 'revoked'")).toBeGreaterThan(-1)
    expect(body.indexOf('-- Release every holder')).toBeLessThan(body.indexOf('-- Bind the target.'))
  })

  it('release frees the identity, revokes the row and clears its session', () => {
    const release = body.slice(body.indexOf('-- Release every holder'), body.indexOf('-- Bind the target.'))
    for (const frag of ['device_id = NULL', "status = 'revoked'", 'active = false', 'refresh_token_hash = NULL', 'refresh_token_expires_at = NULL']) {
      expect(release).toContain(frag)
    }
  })

  it('has NO refusal keyed on the holder belonging to another restaurant', () => {
    expect(body).not.toMatch(/restaurant_id\s*(<>|!=)\s*v_code\.restaurant_id[\s\S]{0,120}RAISE/i)
    expect(body).not.toMatch(/RAISE EXCEPTION '(?!ACTIVATION_)/)
  })

  it('re-validates the code under the row lock', () => {
    expect(body).toMatch(/FROM public\.restaurant_terminals WHERE id = p_code_terminal_id FOR UPDATE/)
    expect(body).toContain('activation_code_expires_at <= v_now')
  })

  it('never deletes a terminal row (history and FKs survive) and never touches orders or payments', () => {
    expect(body).not.toMatch(/DELETE\s+FROM/i)
    expect(body).not.toMatch(/(UPDATE|INSERT INTO)\s+public\.(orders|payments|payment_events|tabs)/i)
  })

  it('is callable by service_role only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activate_terminal_by_code\([^)]*\) FROM anon/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activate_terminal_by_code\([^)]*\) FROM authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.activate_terminal_by_code\([^)]*\) TO service_role/)
  })

  it('does not weaken the physical-device uniqueness indexes', () => {
    const all = walk('supabase/migrations').filter((f) => f >= 'supabase/migrations/20261003')
    for (const f of all) {
      expect(read(f)).not.toMatch(/DROP\s+(INDEX|CONSTRAINT)[^;]*restaurant_terminals_device_(id|serial)_unique/i)
    }
  })
})
