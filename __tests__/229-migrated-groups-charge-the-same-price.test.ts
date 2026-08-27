/**
 * #229 — THE PROOF. No price may change without the venue doing it.
 *
 * The ruling (2026-08-27) is that `variant_groups` becomes the working mechanism and the legacy
 * `menu_items.variants` column goes away, that FNB ChowNow's data migrates AS-IS, and that
 * "every one of the five drinks charges exactly the same before and after, at every size that
 * currently holds a price" must be PROVED rather than asserted.
 *
 * So this file does not restate any price. It:
 *
 *   1. holds the five production rows verbatim, as read on 2026-08-27;
 *   2. PARSES supabase/migrations/20260827122000_issue229_variant_groups_from_legacy_variants.sql
 *      and takes the post-migration `variant_groups` out of the shipped SQL itself — so a typo
 *      in the migration fails here, and a proof against a hand-copied table is impossible;
 *   3. drives the real `calculateOrderPricing` — the code that decides what a customer is
 *      actually charged — over every (drink x size) pair the legacy column prices, in both live
 *      client shapes, before and after, and asserts the charged cents are identical.
 *
 * WHY THIS IS NOT A FORMALITY. The two shapes store price differently: legacy holds an ABSOLUTE
 * per option, the stored groups hold a `price_modifier` DELTA against `base_price`, and the
 * deltas on production do not reproduce the legacy prices. `describe('the naive migration')`
 * below is the POSITIVE CONTROL: it activates the groups as they stand and shows this harness
 * catching three of the five drinks changing price — N$35 to N$45 on a 500ml Americano among
 * them. Without it, the green above would prove only that the test cannot tell.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'
import {
  getDefaultGroupSelection,
  getVariantGroups,
  isRequiredVariantMissing,
  normalizeVariantGroups,
  sanitizeVariantGroupsForWrite,
} from '@/lib/menu/variant-groups'
import { buildMenuItemDbPayload } from '@/lib/menu-item-db-payload'

/** 15% INCLUSIVE, so the charged total equals unit * quantity and the cents are the unit price. */
const TAX_RATES = [
  { id: 'rate-1', name: 'VAT', percentage: 15, is_inclusive: true, is_default: true },
]

const RESTAURANT_ID = 'b161c758-582d-4dfa-839a-9fa35c492a49' // FNB ChowNow

// ---------------------------------------------------------------------------------------------
// 1. PRODUCTION, VERBATIM. menu_items rows read 2026-08-27; `sizes` and `addons` are genuinely
//    empty on all five, which is why base_price is what an unresolved selection falls back to.
// ---------------------------------------------------------------------------------------------

type Row = {
  id: string
  name: string
  base_price: number
  sizes: unknown[]
  addons: unknown[]
  variants: Array<{ size: string; label: string; price: number }>
  variant_groups: unknown[]
  tax_rate_id: string
  status: string
}

/** The stored group every one of the five carries: no `type`, options priced as DELTAS. */
const storedDeltaGroup = (modifiers: number[]) => [
  {
    id: 'size',
    name: 'Size',
    required: true,
    options: [
      { id: '250ml', name: '250ml', price_modifier: modifiers[0] },
      { id: '350ml', name: '350ml', price_modifier: modifiers[1] },
      { id: '500ml', name: '500ml', price_modifier: modifiers[2] },
    ],
  },
]

const PRODUCTION_ROWS: Row[] = [
  {
    id: 'e0cce45c-1b65-4a1f-8c20-939bbbfe7c31',
    name: 'Americano',
    base_price: 35,
    sizes: [],
    addons: [],
    variants: [
      { size: 'S', label: '250ml', price: 35 },
      { size: 'M', label: '350ml', price: 40 },
      // Cheaper than the 350ml. Their menu, not a defect — ruled, and carried across unchanged.
      { size: 'L', label: '500ml', price: 35 },
    ],
    variant_groups: storedDeltaGroup([0, 5, 10]),
    tax_rate_id: 'rate-1',
    status: 'active',
  },
  {
    id: 'e184dfe6-a077-4976-b9f3-286fd48d568b',
    name: 'Cappucinno',
    base_price: 45,
    sizes: [],
    addons: [],
    // TWO options against the group's three, and named so that no label can be matched to a
    // volume. Large-then-Small is the stored order and it decides the default selection.
    variants: [
      { size: 'L', label: 'Large', price: 45 },
      { size: 'S', label: 'Small', price: 35 },
    ],
    variant_groups: storedDeltaGroup([0, 10, 15]),
    tax_rate_id: 'rate-1',
    status: 'active',
  },
  {
    id: 'ad6beab4-8d2e-4244-b0af-3d59e4114cbf',
    name: 'Flat White',
    base_price: 35,
    sizes: [],
    addons: [],
    variants: [
      { size: 'S', label: '250ml', price: 35 },
      { size: 'M', label: '350ml', price: 45 },
      { size: 'L', label: '500ml', price: 50 },
    ],
    variant_groups: storedDeltaGroup([0, 10, 15]),
    tax_rate_id: 'rate-1',
    status: 'active',
  },
  {
    id: 'c38b7879-8859-4a65-90ea-322b2465d264',
    name: 'Red Cappuccino',
    base_price: 45, // above its own cheapest size. Left alone, per the ruling.
    sizes: [],
    addons: [],
    variants: [
      { size: 'S', label: '250ml', price: 35 },
      { size: 'M', label: '350ml', price: 45 },
      { size: 'L', label: '500ml', price: 50 },
    ],
    variant_groups: storedDeltaGroup([0, 10, 15]),
    tax_rate_id: 'rate-1',
    status: 'active',
  },
  {
    id: '9b366863-b787-4598-bb0d-1a3e95371003',
    name: 'Caffè Latte',
    base_price: 35,
    sizes: [],
    addons: [],
    variants: [
      { size: 'S', label: '250ml', price: 35 },
      { size: 'M', label: '350ml', price: 45 },
      { size: 'L', label: '500ml', price: 50 },
    ],
    variant_groups: storedDeltaGroup([0, 10, 15]),
    tax_rate_id: 'rate-1',
    status: 'active',
  },
]

// ---------------------------------------------------------------------------------------------
// 2. THE MIGRATION, READ OFF DISK. Not a transcription of it — the file itself.
// ---------------------------------------------------------------------------------------------

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260827122000_issue229_variant_groups_from_legacy_variants.sql',
)
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8')

/** The `variant_groups` each UPDATE writes, keyed by the row it targets. */
function parseMigratedGroups(sql: string): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  const statement =
    /UPDATE menu_items SET variant_groups = '([\s\S]*?)'::jsonb[\s\S]*?WHERE id = '([0-9a-f-]{36})';/g
  for (const match of sql.matchAll(statement)) {
    out.set(match[2], JSON.parse(match[1]) as unknown[])
  }
  return out
}

/** The legacy `variants` its precondition refuses to run without. */
function parsePreconditionVariants(sql: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const entry = /'([0-9a-f-]{36})',\s*'(\[[\s\S]*?\])'::jsonb/g
  for (const match of sql.matchAll(entry)) {
    out.set(match[1], JSON.parse(match[2]) as unknown)
  }
  return out
}

const MIGRATED = parseMigratedGroups(MIGRATION_SQL)
const PRECONDITION = parsePreconditionVariants(MIGRATION_SQL)

/** The same row after the migration: only `variant_groups` moves. */
const afterMigration = (row: Row): Row => ({ ...row, variant_groups: MIGRATED.get(row.id) ?? [] })

/**
 * THE POSITIVE CONTROL. "Activate the groups as they stand": give them the `type` they lack and
 * read each `price_modifier` as a delta on `base_price`. This is the migration nobody should
 * write, and it exists here so a passing suite above means something.
 */
const naiveActivation = (row: Row): Row => ({
  ...row,
  variant_groups: (row.variant_groups as Array<Record<string, any>>).map((group) => ({
    name: group.name,
    required: group.required,
    type: 'price',
    options: (group.options as Array<Record<string, any>>).map((opt) => ({
      label: opt.name,
      price: row.base_price + opt.price_modifier,
    })),
  })),
})

// ---------------------------------------------------------------------------------------------
// 3. THE REAL PRICER. Same client stub as __tests__/117-variant-pricing-honours-the-selection:
//    it PROJECTS the selected columns, so dropping `variants` or `variant_groups` from the query
//    breaks these cases rather than silently passing.
// ---------------------------------------------------------------------------------------------

let selectedColumns = ''

function project(row: Record<string, unknown>, cols: string): Record<string, unknown> {
  const wanted = cols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const col of wanted) if (col in row) out[col] = row[col]
  return out
}

function makeClient(rows: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table === 'tax_rates') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => Promise.resolve({ data: TAX_RATES, error: null }),
          then: (res: (v: unknown) => void) => res({ data: TAX_RATES, error: null }),
        }
        return b
      }
      if (table !== 'menu_items') throw new Error(`unexpected table ${table}`)
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          selectedColumns = cols
          return b
        },
        eq: () => b,
        in: (_col: string, ids: string[]) =>
          Promise.resolve({
            data: rows
              .filter((r) => ids.includes(String(r.id)))
              .map((r) => project(r, selectedColumns)),
            error: null,
          }),
      }
      return b
    },
  }
}

const asClient = (c: unknown) => c as Parameters<typeof calculateOrderPricing>[0]
const cents = (n: number) => Math.round(n * 100)

/**
 * What the customer is charged for one drink at one size, through the shipped pricer.
 *
 * `shape` covers both live client shapes: the browse page and ItemDetailModal post a
 * `selectedVariants` map AND mirror the choice into `selected_size`, while a cart line hydrated
 * out of localStorage by an older build carries the bare size string alone.
 */
async function chargedCents(
  row: Row,
  label: string,
  shape: 'selection' | 'bare-size',
): Promise<{ total: number; warnings: string[] }> {
  const line =
    shape === 'selection'
      ? { menuItemId: row.id, quantity: 1, selectedVariants: { Size: label }, size: label }
      : { menuItemId: row.id, quantity: 1, size: label }
  const result = await calculateOrderPricing(asClient(makeClient([row])), RESTAURANT_ID, [line])
  return { total: cents(result.total), warnings: result.warnings }
}

const SHAPES: Array<'selection' | 'bare-size'> = ['selection', 'bare-size']

// ---------------------------------------------------------------------------------------------

describe('#229 the migration file is the one this proof is about', () => {
  it('writes a new variant_groups for each of the five drinks and for nothing else', () => {
    expect([...MIGRATED.keys()].sort()).toEqual(PRODUCTION_ROWS.map((r) => r.id).sort())
  })

  it('refuses to run against data that has moved: its precondition is today s legacy column', () => {
    // Binds the guard to the measurement. If production is re-read and a price has changed, the
    // fixture above moves, this fails, and the migration is re-derived instead of applied.
    expect([...PRECONDITION.keys()].sort()).toEqual(PRODUCTION_ROWS.map((r) => r.id).sort())
    for (const row of PRODUCTION_ROWS) {
      expect(PRECONDITION.get(row.id)).toEqual(row.variants)
    }
  })

  it('stores no price_modifier anywhere — the canonical option shape is an ABSOLUTE price', () => {
    // A `price_modifier` on a variant-group option is read by no code in this repository, so a
    // migrated row must not carry one. This is also why Cappucinno needs no negative modifier:
    // its Small is stored as 35, not as -10 against a base of 45.
    expect(JSON.stringify([...MIGRATED.values()])).not.toContain('price_modifier')
  })
})

describe('#229 THE PROOF: every drink charges the same at every size that holds a price', () => {
  for (const before of PRODUCTION_ROWS) {
    const after = afterMigration(before)

    describe(before.name, () => {
      for (const variant of before.variants) {
        for (const shape of SHAPES) {
          it(`${variant.label} (${shape}) charges N$${variant.price} before AND after`, async () => {
            const wasCharged = await chargedCents(before, variant.label, shape)
            const nowCharged = await chargedCents(after, variant.label, shape)

            // The equality the ruling demands, asserted as a comparison of the two runs...
            expect(nowCharged.total).toBe(wasCharged.total)
            // ...and pinned to the venue's own figure, so both sides being wrong cannot pass.
            expect(nowCharged.total).toBe(cents(variant.price))
          })
        }
      }

      it('the customer is offered exactly the same options, in the same order', async () => {
        expect(getVariantGroups(after)).toEqual(getVariantGroups(before))
      })

      it('the size selected when the item opens does not move', () => {
        expect(getDefaultGroupSelection(after)).toEqual(getDefaultGroupSelection(before))
      })

      it('is no more and no less required than it was', () => {
        expect(isRequiredVariantMissing(after, {})).toBe(isRequiredVariantMissing(before, {}))
        expect(isRequiredVariantMissing(after, getDefaultGroupSelection(after))).toBe(false)
      })

      it('prices a line with no selection from base_price, exactly as before', async () => {
        const wasCharged = await calculateOrderPricing(
          asClient(makeClient([before])),
          RESTAURANT_ID,
          [{ menuItemId: before.id, quantity: 1 }],
        )
        const nowCharged = await calculateOrderPricing(asClient(makeClient([after])), RESTAURANT_ID, [
          { menuItemId: after.id, quantity: 1 },
        ])
        expect(cents(nowCharged.total)).toBe(cents(wasCharged.total))
        expect(cents(nowCharged.total)).toBe(cents(before.base_price))
      })

      it('reports no new pricing fault', async () => {
        for (const variant of before.variants) {
          const nowCharged = await chargedCents(after, variant.label, 'selection')
          expect(nowCharged.warnings).toEqual([])
        }
      })
    })
  }
})

describe('#229 the source of truth actually moves — otherwise the proof above is vacuous', () => {
  it('BEFORE: the stored group is discarded and the customer is shown the LEGACY column', () => {
    for (const row of PRODUCTION_ROWS) {
      expect(normalizeVariantGroups(row.variant_groups)).toEqual([])
    }
  })

  it('AFTER: the stored group is what the customer is shown, and the legacy column is unread', () => {
    for (const row of PRODUCTION_ROWS) {
      const after = afterMigration(row)
      expect(normalizeVariantGroups(after.variant_groups).length).toBe(1)
      // Blank the legacy column and nothing moves: it is no longer load-bearing for these rows.
      expect(getVariantGroups({ ...after, variants: [] })).toEqual(getVariantGroups(after))
    }
  })

  it('the legacy column is left in place by the migration, so this stage is reversible', () => {
    expect(MIGRATION_SQL).not.toMatch(/SET\s+variants\s*=/i)
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+COLUMN/i)
  })
})

describe("#229 Cappucinno's blank third option", () => {
  const cappucinno = PRODUCTION_ROWS.find((r) => r.name === 'Cappucinno')!
  const migrated = afterMigration(cappucinno)
  const options = (migrated.variant_groups as Array<{ options: unknown[] }>)[0].options

  it('carries the two options that exist and ONE blank — no invented third price', () => {
    expect(options).toEqual([
      { label: 'Large', price: 45 },
      { label: 'Small', price: 35 },
      { label: '', price: null },
    ])
  })

  it('the blank is invisible to customers: they still see Large and Small only', () => {
    expect(getVariantGroups(migrated)[0].options).toEqual([
      { label: 'Large', price: 45 },
      { label: 'Small', price: 35 },
    ])
  })

  it('the blank cannot be ordered, and cannot be charged for', async () => {
    const result = await calculateOrderPricing(asClient(makeClient([migrated])), RESTAURANT_ID, [
      { menuItemId: migrated.id, quantity: 1, selectedVariants: { Size: '' } },
    ])
    // An empty selection is not a selection: it falls back to base_price and nothing is
    // resolved to a N$0.00 option.
    expect(cents(result.total)).toBe(cents(45))
  })
})

describe('#229 the migrated rows survive the menu editor — the writer half of the bug', () => {
  it('every migrated group round-trips through the writer UNCHANGED', () => {
    // buildMenuItemDbPayload is the funnel every write passes through, editor and API alike. If
    // it reshaped a migrated group, the venue would undo the migration by saving a photo.
    for (const row of PRODUCTION_ROWS) {
      const groups = MIGRATED.get(row.id)!
      expect(buildMenuItemDbPayload({ variant_groups: groups }).variant_groups).toEqual(groups)
      expect(buildMenuItemDbPayload({ variantGroups: groups }).variant_groups).toEqual(groups)
    }
  })

  it("Cappucinno's blank option is still there after a save, waiting to be filled in", () => {
    const groups = MIGRATED.get('e184dfe6-a077-4976-b9f3-286fd48d568b')!
    const saved = sanitizeVariantGroupsForWrite(groups).groups as Array<{ options: unknown[] }>

    expect(saved[0].options).toEqual([
      { label: 'Large', price: 45 },
      { label: 'Small', price: 35 },
      { label: '', price: null },
    ])
    // ...and the group is NOT reported as something the system could not handle.
    expect(sanitizeVariantGroupsForWrite(groups).unconvertible).toEqual([])
  })

  it('a price typed into the blank becomes a real option, and nothing else moves', () => {
    const groups = MIGRATED.get('e184dfe6-a077-4976-b9f3-286fd48d568b')! as Array<{
      options: unknown[]
      name: string
      required: boolean
      type: string
    }>
    // Exactly what the form state holds after someone types into the two empty boxes.
    const edited = [
      { ...groups[0], options: [...groups[0].options.slice(0, 2), { label: 'Medium', price: 40 }] },
    ]
    const saved = sanitizeVariantGroupsForWrite(edited).groups as Array<{ options: unknown[] }>

    expect(saved[0].options).toEqual([
      { label: 'Large', price: 45 },
      { label: 'Small', price: 35 },
      { label: 'Medium', price: 40 },
    ])
  })

  it('a LABELLED option with no price is still dropped — a blank must never become free', () => {
    // Number(null) is 0 and normalizeVariantGroups accepts it, so storing a labelled option with
    // no price would put a N$0.00 Medium in front of customers. Only an unlabelled option, which
    // the reader discards on the label test alone, may be stored unpriced.
    const saved = sanitizeVariantGroupsForWrite([
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: [
          { label: 'Large', price: 45 },
          { label: 'Medium', price: null },
        ],
      },
    ]).groups as Array<{ options: unknown[] }>

    expect(saved[0].options).toEqual([{ label: 'Large', price: 45 }])
    expect(normalizeVariantGroups(saved)[0].options).toEqual([{ label: 'Large', price: 45 }])
  })

  it('a group of NOTHING BUT blanks is not treated as a usable group', () => {
    // Guard against the trap this whole issue is about: a stored group that normalises to
    // nothing sends getVariantGroups back to the legacy column, resurrecting old prices.
    const { groups, unconvertible } = sanitizeVariantGroupsForWrite([
      { name: 'Size', required: true, type: 'price', options: [{ label: '', price: null }] },
    ])
    expect(unconvertible).toEqual(['Size'])
    expect(normalizeVariantGroups(groups)).toEqual([])
  })
})

describe('#229 the naive migration — POSITIVE CONTROL, so a green suite above means something', () => {
  it('activating the stored deltas raises a 500ml Americano from N$35 to N$45', async () => {
    const americano = PRODUCTION_ROWS.find((r) => r.name === 'Americano')!
    const wasCharged = await chargedCents(americano, '500ml', 'selection')
    const naive = await chargedCents(naiveActivation(americano), '500ml', 'selection')

    expect(wasCharged.total).toBe(3500)
    expect(naive.total).toBe(4500)
    expect(naive.total).not.toBe(wasCharged.total) // <- the harness CAN see a price change
  })

  it('and it moves three of the five drinks, not one', async () => {
    const moved: string[] = []
    for (const row of PRODUCTION_ROWS) {
      const naive = naiveActivation(row)
      for (const variant of row.variants) {
        const wasCharged = await chargedCents(row, variant.label, 'selection')
        const nowCharged = await chargedCents(naive, variant.label, 'selection')
        if (nowCharged.total !== wasCharged.total && !moved.includes(row.name)) moved.push(row.name)
      }
    }
    // Cappucinno moves because its Large/Small labels match no volume at all, so every selection
    // falls through to base_price under the naive shape.
    expect(moved.sort()).toEqual(['Americano', 'Cappucinno', 'Red Cappuccino'])
  })

  it('CONTROL ON THE CONTROL: the migration this repo ships moves none of them', async () => {
    const moved: string[] = []
    for (const row of PRODUCTION_ROWS) {
      const after = afterMigration(row)
      for (const variant of row.variants) {
        const wasCharged = await chargedCents(row, variant.label, 'selection')
        const nowCharged = await chargedCents(after, variant.label, 'selection')
        if (nowCharged.total !== wasCharged.total && !moved.includes(row.name)) moved.push(row.name)
      }
    }
    expect(moved).toEqual([])
  })
})
