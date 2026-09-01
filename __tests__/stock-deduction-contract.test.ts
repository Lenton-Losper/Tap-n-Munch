/**
 * The stock deduction contract, enforced.
 *
 * `docs/stock-deduction-contract.md` states when stock moves, what makes it idempotent, and what
 * a retry / void / refund does. A document nobody can fail is a document that goes stale, and this
 * codebase has already been bitten by exactly that: `supabase/schema.sql` still carries a copy of
 * `deduct_recipe_stock` from before the advisory lock and before the `track_inventory` gate, so
 * anyone reading the schema dump concludes untracked items still deduct — true until
 * 20260731230000, false ever since.
 *
 * ============================================================================================
 * WHY THIS READS A MIGRATION AND NOT schema.sql
 * ============================================================================================
 *
 * Because schema.sql is the stale one. The authoritative definition is the LAST migration that
 * redefines the function, which today is `20260801010000_recipes_soft_delete.sql` — a filename
 * that gives no hint it contains it, and which is NOT the migration named after the
 * track_inventory change.
 *
 * So the file is not hard-coded. `authoritativeDefinition()` scans every migration, picks the
 * newest one that redefines the function, and the tests assert against that. If someone adds
 * `20261001_whatever.sql` with a new definition, these tests follow it automatically — and the
 * first test fails loudly if the file it picked is no longer the one the contract document names,
 * so the document cannot quietly start describing a function that no longer exists.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations')
const DOC = join(__dirname, '..', 'docs', 'stock-deduction-contract.md')

const DEFINITION_RE = /CREATE OR REPLACE FUNCTION\s+"?public"?\."?deduct_recipe_stock"?/

/** The newest migration that redefines deduct_recipe_stock, with its body. */
function authoritativeDefinition(): { file: string; sql: string } {
  const hits = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => DEFINITION_RE.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))

  if (hits.length === 0) {
    throw new Error('no migration defines deduct_recipe_stock — the contract has lost its subject')
  }
  const file = hits[hits.length - 1]
  return { file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }
}

const authoritative = authoritativeDefinition()
const doc = readFileSync(DOC, 'utf8')

describe('the contract document describes the function that actually exists', () => {
  it('names the authoritative migration', () => {
    // If this fails, a newer migration took over the function and the document is now describing
    // a definition nobody runs. Fix the document, do not delete this test.
    expect(doc).toContain(authoritative.file)
  })

  it('more than one migration has redefined it — so "latest wins" is the only safe rule', () => {
    const all = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => DEFINITION_RE.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    expect(all.length).toBeGreaterThan(1)
  })
})

describe('WHEN: deduction fires at completion, once, from a trigger', () => {
  it('the trigger fires only on the transition INTO completed', () => {
    const trigger = readFileSync(
      join(MIGRATIONS_DIR, '20260701120000_recipe_bom_deduction.sql'),
      'utf8',
    )
    expect(trigger).toMatch(/AFTER UPDATE OF status ON\s+"?public"?\."?orders"?/)
    // Both halves matter: NEW.status = completed alone would re-fire on every later update of a
    // completed order, and the idempotency guard would then be the only thing standing between
    // the ledger and a double deduction.
    expect(trigger).toMatch(/NEW\.status\s*=\s*'completed'/)
    expect(trigger).toMatch(/OLD\.status IS DISTINCT FROM 'completed'/)
  })

  it('no application code performs the deduction itself', () => {
    // The whole point of it being a trigger: there is exactly one writer of reason='sale'.
    const roots = ['app', 'lib']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(__dirname, '..', dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          walk(rel)
        } else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(join(__dirname, '..', rel), 'utf8')
          if (/reason:\s*'sale'/.test(src)) offenders.push(rel)
        }
      }
    }
    roots.forEach(walk)
    expect(offenders).toEqual([])
  })
})

describe('WHAT: both halves of the tracking state must agree', () => {
  it('requires an active recipe AND track_inventory IS TRUE', () => {
    expect(authoritative.sql).toContain('track_inventory IS TRUE')
    expect(authoritative.sql).toMatch(/r\.is_active\s*=\s*true/)
  })

  it('uses IS TRUE, so a NULL track_inventory is NOT tracked', () => {
    // `= true` would behave the same for NULL in a WHERE clause, but IS TRUE says the intent out
    // loud and cannot be flipped to `IS NOT FALSE` by someone "simplifying" it.
    expect(authoritative.sql).not.toMatch(/track_inventory\s*=\s*true/i)
  })
})

describe('IDEMPOTENCY: the same order never deducts twice', () => {
  it('returns early when any movement already references the order', () => {
    expect(authoritative.sql).toMatch(/reference_type\s*=\s*'order'/)
    expect(authoritative.sql).toMatch(/reference_id\s*=\s*p_order_id/)
    expect(authoritative.sql).toMatch(/IF EXISTS[\s\S]{0,400}?RETURN;/)
  })

  it('takes per-stock-item advisory locks in a deterministic order', () => {
    expect(authoritative.sql).toContain('pg_advisory_xact_lock')
    // ORDER BY stock_item_id is the anti-deadlock property, not a tidiness preference.
    expect(authoritative.sql).toMatch(/ORDER BY stock_item_id/)
  })

  it('cannot block order completion — every line-item failure is isolated', () => {
    expect(authoritative.sql).toMatch(/EXCEPTION[\s\S]{0,200}?WHEN OTHERS/)
    expect(authoritative.sql).toMatch(/RAISE WARNING/)
  })
})

describe('REVERSAL: there is deliberately none, and the ledger vocabulary proves it', () => {
  /**
   * The reason CHECK is the whole statement of what may move stock. If a reversal reason ever
   * appears here, someone has made the accounting decision recorded as open in §5 of the contract,
   * and this test is where they say so.
   */
  it('no reason exists for undoing a sale', () => {
    const constraintFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('stock_movements_reason_check'),
      )
    expect(constraintFiles.length).toBeGreaterThan(0)

    const latest = readFileSync(
      join(MIGRATIONS_DIR, constraintFiles[constraintFiles.length - 1]),
      'utf8',
    )
    const allowed = [...latest.matchAll(/'([a-z_]+)'::"?text"?/g)].map((m) => m[1])
    expect(allowed.length).toBeGreaterThan(0)

    for (const forbidden of ['sale_reversal', 'refund', 'void', 'reversal', 'return']) {
      expect(allowed).not.toContain(forbidden)
    }
    // And the ones that must still be there.
    expect(allowed).toEqual(expect.arrayContaining(['sale', 'adjustment', 'received']))
  })

  it('a completed order cannot be cancelled, so stock cannot be stranded that way', () => {
    const route = readFileSync(
      join(__dirname, '..', 'app', 'api', 'terminal', 'orders', '[orderId]', 'status', 'route.ts'),
      'utf8',
    )
    expect(route).toMatch(/currentStatus !== 'completed'/)
  })
})

describe('PLACEMENT: sufficiency is refused early, never at completion', () => {
  it('every order-creating route checks sufficiency before accepting', () => {
    const routes = [
      'app/api/orders/route.ts',
      'app/api/terminal/orders/route.ts',
      'app/api/terminal/rounds/route.ts',
      'lib/orders/apply-edit-additions.ts',
    ]
    for (const r of routes) {
      const src = readFileSync(join(__dirname, '..', r), 'utf8')
      expect(src).toContain('checkStockSufficiency')
    }
  })

  it('the deduction function itself does NOT refuse — by design', () => {
    // Raising here would either be swallowed by the handlers above (no effect) or, with them
    // removed, strand orders that cannot be completed after the customer has been served.
    expect(authoritative.sql).not.toMatch(/RAISE EXCEPTION[\s\S]{0,120}stock/i)
  })
})
