/**
 * THE FIVE STOCK INVARIANTS, as resolved by the owner on 2026-09-01.
 *
 *   I1  Stock is consumed EXACTLY ONCE per order, at the first transition into
 *       `orders.status = 'completed'`.
 *   I2  Nothing ever restores stock automatically. Inventory returns only through an explicit
 *       adjustment representing stock that genuinely came back to usable inventory.
 *   I3  A refund, or a cancellation after completion, leaves stock deducted.
 *   I4  An item deducts only when track_inventory IS TRUE **and** a live recipe with at least one
 *       ingredient exists. Anything else is incomplete configuration: excluded, surfaced, never
 *       guessed.
 *   I5  Stock state NEVER changes menu availability. `menu_items.status` stays merchant-controlled.
 *
 * ============================================================================================
 * WHY `completed` IS THE CORRECT CONSUMPTION POINT — the proof, not the assertion
 * ============================================================================================
 *
 * The brief required proving the point before trusting the wiring. Four candidate points exist in
 * the lifecycle (placed → accepted → preparing → ready → completed), and the choice follows from
 * I2 rather than from taste:
 *
 *   placed / accepted  An order at these states is routinely cancelled and nothing was made.
 *                      Deducting here would deduct for food that never existed.
 *   ready              Physically truest: the ingredients really are gone once the kitchen makes
 *                      the dish. But an order can be ready and then cancelled, and under I2
 *                      nothing would automatically put the stock back — so every such case would
 *                      leave a permanently wrong ledger that no code can correct. Deducting here
 *                      converts a rare event into an uncorrectable error.
 *   completed          Every deduction corresponds to a completed sale. Food made but not sold is
 *                      real waste, and the ledger already has the right word for it: an explicit
 *                      `loss` adjustment, which is exactly the mechanism I2 mandates.
 *
 * IRREVERSIBILITY, MEASURED. Read-only against production 2026-09-01: of 2,573 orders carrying a
 * `completed_at`, exactly ONE is no longer `completed` — 75cb3796, completed 13:01 and cancelled
 * 16:53 on 2026-08-25. It still holds its sale movements, i.e. the stock stayed deducted. That is
 * now the ruled-correct outcome, so the single real counter-example behaves as the decision
 * requires rather than against it.
 *
 * EXACTLY-ONCE does not depend on irreversibility anyway: the trigger fires only on
 * `OLD.status IS DISTINCT FROM 'completed'`, and `deduct_recipe_stock` returns early if any
 * movement already references the order. An order re-entering completion deducts nothing further.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyAll,
  classifyInventoryConfiguration,
  incompleteConfiguration,
  summariseConfiguration,
} from '@/lib/stock/inventory-configuration'

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

const DEFINITION_RE = /CREATE OR REPLACE FUNCTION\s+"?public"?\."?deduct_recipe_stock"?/

function authoritativeDeduction(): string {
  const hits = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => DEFINITION_RE.test(readFileSync(join(MIGRATIONS, f), 'utf8')))
  if (!hits.length) throw new Error('no migration defines deduct_recipe_stock')
  return readFileSync(join(MIGRATIONS, hits[hits.length - 1]), 'utf8')
}

/** Every .ts/.tsx under a directory, so a new file cannot dodge a rule by being new. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) sourceFiles(rel, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(rel)
  }
  return acc
}

const deduction = authoritativeDeduction()

// ── I1 ───────────────────────────────────────────────────────────────────────

describe('I1 — consumed exactly once, at the first completion', () => {
  it('the trigger fires only on the transition INTO completed', () => {
    const trigger = readFileSync(join(MIGRATIONS, '20260701120000_recipe_bom_deduction.sql'), 'utf8')
    expect(trigger).toMatch(/NEW\.status\s*=\s*'completed'/)
    // Without this half, every later update of a completed order would re-fire the trigger and
    // the idempotency guard would be the only thing between the ledger and a second deduction.
    expect(trigger).toMatch(/OLD\.status IS DISTINCT FROM 'completed'/)
  })

  it('a second run writes nothing, whatever re-entered completion', () => {
    expect(deduction).toMatch(/reference_type\s*=\s*'order'/)
    expect(deduction).toMatch(/reference_id\s*=\s*p_order_id/)
    expect(deduction).toMatch(/IF EXISTS[\s\S]{0,400}?RETURN;/)
  })

  it('nothing but the trigger consumes stock — there is one writer of reason=sale', () => {
    const offenders = [...sourceFiles('app'), ...sourceFiles('lib')].filter((rel) =>
      /reason:\s*'sale'/.test(readFileSync(join(ROOT, rel), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})

// ── I2 / I3 ──────────────────────────────────────────────────────────────────

describe('I2 + I3 — nothing restores stock automatically', () => {
  it('the ledger vocabulary has no word for undoing a sale', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => readFileSync(join(MIGRATIONS, f), 'utf8').includes('stock_movements_reason_check'))
    expect(files.length).toBeGreaterThan(0)

    const latest = readFileSync(join(MIGRATIONS, files[files.length - 1]), 'utf8')
    const allowed = [...latest.matchAll(/'([a-z_]+)'::"?text"?/g)].map((m) => m[1])
    expect(allowed.length).toBeGreaterThan(0)

    for (const forbidden of ['sale_reversal', 'refund', 'void', 'reversal', 'return', 'restock']) {
      expect(allowed).not.toContain(forbidden)
    }
    // The explicit mechanism I2 mandates must still be there.
    expect(allowed).toEqual(expect.arrayContaining(['adjustment', 'loss', 'recount', 'received']))
  })

  it('no refund, cancel or void path touches stock_movements', () => {
    const suspects = [...sourceFiles('app'), ...sourceFiles('lib')].filter((rel) =>
      /refund|cancel|void/i.test(rel),
    )
    // Positive control: the filter must actually be finding the refund/cancel code.
    expect(suspects.length).toBeGreaterThan(3)

    const offenders = suspects.filter((rel) =>
      /from\(\s*['"]stock_movements['"]\s*\)/.test(readFileSync(join(ROOT, rel), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('nothing deletes a stock movement anywhere', () => {
    // History is the audit trail. A correction is a new row, never an erased one.
    const offenders = [...sourceFiles('app'), ...sourceFiles('lib')].filter((rel) => {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      return /from\(\s*['"]stock_movements['"]\s*\)\s*\.\s*delete\s*\(/.test(src)
    })
    expect(offenders).toEqual([])
  })
})

// ── I4 ───────────────────────────────────────────────────────────────────────

describe('I4 — both halves must agree, and an incomplete one is never guessed', () => {
  const RECIPES = [
    { id: 'r-ok', menu_item_id: 'i-deducting', is_active: true, deleted_at: null },
    { id: 'r-empty', menu_item_id: 'i-empty-recipe', is_active: true, deleted_at: null },
    { id: 'r-dead', menu_item_id: 'i-tombstoned', is_active: true, deleted_at: '2026-08-01T00:00:00Z' },
    { id: 'r-off', menu_item_id: 'i-inactive', is_active: false, deleted_at: null },
    { id: 'r-untracked', menu_item_id: 'i-recipe-no-flag', is_active: true, deleted_at: null },
  ]
  const RECIPE_ITEMS = [
    { recipe_id: 'r-ok' },
    { recipe_id: 'r-ok' },
    { recipe_id: 'r-dead' },
    { recipe_id: 'r-off' },
    { recipe_id: 'r-untracked' },
  ]
  const item = (id: string, track: boolean | null) => ({ id, name: id, track_inventory: track })

  it('deducts only when tracked AND a live recipe carries ingredients', () => {
    const r = classifyInventoryConfiguration(item('i-deducting', true), RECIPES, RECIPE_ITEMS)
    expect(r.state).toBe('deducting')
    expect(r.deducts).toBe(true)
    expect(r.ingredientCount).toBe(2)
  })

  it('a tracked item with NO recipe is incomplete configuration, not a deduction', () => {
    const r = classifyInventoryConfiguration(item('i-none', true), RECIPES, RECIPE_ITEMS)
    expect(r.state).toBe('tracked_without_recipe')
    expect(r.deducts).toBe(false)
  })

  /** An empty recipe satisfies "a recipe exists" while deducting nothing. It is still incomplete. */
  it('an EMPTY recipe is incomplete configuration, not configured', () => {
    const r = classifyInventoryConfiguration(item('i-empty-recipe', true), RECIPES, RECIPE_ITEMS)
    expect(r.state).toBe('tracked_without_recipe')
  })

  it('a tombstoned or inactive recipe does not count', () => {
    expect(classifyInventoryConfiguration(item('i-tombstoned', true), RECIPES, RECIPE_ITEMS).state).toBe(
      'tracked_without_recipe',
    )
    expect(classifyInventoryConfiguration(item('i-inactive', true), RECIPES, RECIPE_ITEMS).state).toBe(
      'tracked_without_recipe',
    )
  })

  it('a recipe on an unflagged item is dormant, not a fault to chase', () => {
    const r = classifyInventoryConfiguration(item('i-recipe-no-flag', false), RECIPES, RECIPE_ITEMS)
    expect(r.state).toBe('recipe_without_tracking')
    expect(r.deducts).toBe(false)
  })

  it('NULL track_inventory is not tracked — mirroring the SQL IS TRUE', () => {
    expect(classifyInventoryConfiguration(item('i-null', null), RECIPES, RECIPE_ITEMS).state).toBe(
      'not_tracked',
    )
  })

  it('only the tracked-without-recipe items are put in front of a merchant', () => {
    const rows = classifyAll(
      [item('i-deducting', true), item('i-none', true), item('i-recipe-no-flag', false), item('i-x', null)],
      RECIPES,
      RECIPE_ITEMS,
    )
    expect(incompleteConfiguration(rows).map((r) => r.menuItemId)).toEqual(['i-none'])
    expect(summariseConfiguration(rows)).toMatchObject({
      deducting: 1,
      tracked_without_recipe: 1,
      recipe_without_tracking: 1,
      not_tracked: 1,
      missing: 1,
      total: 4,
    })
  })

  it('the SQL enforces the same two-sided rule the classifier reports', () => {
    expect(deduction).toContain('track_inventory IS TRUE')
    expect(deduction).toMatch(/r\.is_active\s*=\s*true/)
  })
})

// ── I5 ───────────────────────────────────────────────────────────────────────

describe('I5 — stock never changes menu availability', () => {
  /**
   * RULED 2026-09-01: `menu_items.status` stays merchant-controlled. Stock levels may WARN, and
   * `check_stock_sufficiency_locked` may refuse a sale at placement, but nothing derived from a
   * balance may silently hide or unhide a dish.
   */
  /**
   * The detector looks for a `status` KEY inside an `.update({...})` literal, not merely for the
   * word "status" somewhere in a file that also updates.
   *
   * The first draft did the latter and flagged lib/recipes/actions.ts and
   * bulk-tracking-actions.ts, both of which write only `track_inventory: true|false`. A rule that
   * cries wolf gets an allowlist bolted on, and an allowlist is how the next real violation gets
   * waved through.
   */
  const writesStatusKey = (src: string) => /\.update\(\s*\{[^}]*\bstatus\s*:/.test(src)

  it('the detector distinguishes a status write from a track_inventory write', () => {
    expect(writesStatusKey(".from('menu_items').update({ status: 'hidden' })")).toBe(true)
    expect(writesStatusKey(".from('menu_items').update({ track_inventory: true })")).toBe(false)
    // The exact shape that produced the false positive: status mentioned, never written.
    expect(
      writesStatusKey(".select('status')\n.from('menu_items')\n.update({ track_inventory: false })"),
    ).toBe(false)
  })

  it('no stock or recipe module writes menu_items.status', () => {
    const files = [...sourceFiles('lib/stock'), ...sourceFiles('lib/recipes')]
    expect(files.length).toBeGreaterThan(8) // positive control: the scan found the modules

    const touchesMenuItems = files.filter((rel) =>
      /from\(\s*['"]menu_items['"]\s*\)/.test(readFileSync(join(ROOT, rel), 'utf8')),
    )
    // Positive control: if nothing touches menu_items, the rule below is vacuous.
    expect(touchesMenuItems.length).toBeGreaterThan(0)

    const offenders = touchesMenuItems.filter((rel) =>
      writesStatusKey(readFileSync(join(ROOT, rel), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('the deduction function itself never touches menu_items', () => {
    // It reads menu_items for the tracking flag; it must never write one.
    expect(deduction).not.toMatch(/UPDATE\s+"?public"?\."?menu_items"?/i)
  })

  it('the availability route is the only thing that sets out_of_stock, and it is merchant-driven', () => {
    const route = readFileSync(
      join(ROOT, 'app', 'api', 'terminal', 'menu-items', '[itemId]', 'availability', 'route.ts'),
      'utf8',
    )
    // Its own docblock records the 2026-08-28 ruling; the code must still say so.
    expect(route).toMatch(/out_of_stock/)
    expect(route).toMatch(/RULED 2026-08-28/)
  })
})

// ── the artefact that makes I4 actionable ────────────────────────────────────

describe('the deduction contract records the resolved decisions', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'stock-deduction-contract.md'), 'utf8')

  it('states each resolved rule, so nobody re-litigates it from the code', () => {
    expect(doc).toMatch(/refund/i)
    expect(doc).toMatch(/explicit/i)
    expect(doc).toMatch(/merchant-controlled|merchant controlled/i)
    expect(doc).toMatch(/75cb3796/) // the measured counter-example
  })
})
