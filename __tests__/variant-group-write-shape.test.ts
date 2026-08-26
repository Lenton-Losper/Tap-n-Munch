/**
 * #229 -- FIX THE WRITER, and prove it fixed nothing it was not asked to.
 *
 * Ruled 2026-08-26: "Browse drops every production variant group with no `type` field -- the
 * correction goes in whatever writes those groups, not in a reader that tolerates the gap."
 *
 * There are two writers and they had drifted:
 *
 *   components/menu/menu-item-form-modal.tsx  -- a private sanitiser that read an option label
 *                                                as `label` only, and DISCARDED what it could
 *                                                not clean
 *   lib/menu-item-db-payload.ts               -- the funnel every write passes through, which
 *                                                copied `variant_groups` straight from the
 *                                                request body with no shape guarantee at all
 *
 * Both now run lib/menu/variant-groups.ts#sanitizeVariantGroupsForWrite.
 *
 * THE HAZARD THESE TESTS EXIST TO PIN. Production's five rows price their options as
 * `price_modifier` DELTAS; every reader in this codebase expects a `price` ABSOLUTE. Reading
 * one as the other would sell a `price_modifier: 0` default size for N$0.00 against N$45 today,
 * and deriving `base_price + modifier` would be a shape converter doing arithmetic on money.
 * So the last four tests here assert the NEGATIVE: after this change, production's groups are
 * still inert, the customer is still offered the legacy Large/Small at N$45/N$35, and nothing
 * new reaches the pricer. That matters beyond #229 -- #117 (calculate-order-pricing never
 * selects `variant_groups` and silently falls back to `base_price`) is masked ONLY by those
 * groups being inert, so a change that quietly woke them would turn a N$0.00 measured impact
 * into a live undercharge.
 */
import {
  findMissingRequiredVariantGroups,
  getVariantGroups,
  normalizeVariantGroups,
  sanitizeVariantGroupsForWrite,
} from '@/lib/menu/variant-groups'
import { buildMenuItemDbPayload } from '@/lib/menu-item-db-payload'

/** Verbatim from production menu_items row e184dfe6-a077-4976-b9f3-286fd48d568b, "Cappucinno". */
const PROD_REQUIRED_GROUP = {
  id: 'size',
  name: 'Size',
  options: [
    { id: '250ml', name: '250ml', price_modifier: 0 },
    { id: '350ml', name: '350ml', price_modifier: 10 },
    { id: '500ml', name: '500ml', price_modifier: 15 },
  ],
  required: true,
}

/** The same row's legacy column -- what customers are actually offered and charged today. */
const PROD_LEGACY_VARIANTS = [
  { size: 'L', label: 'Large', price: 45 },
  { size: 'S', label: 'Small', price: 35 },
]

describe('#229 sanitizeVariantGroupsForWrite: a missing `type` is filled in at the writer', () => {
  it('infers type "price" for a typeless group whose options carry ABSOLUTE prices', () => {
    const { groups, unconvertible } = sanitizeVariantGroupsForWrite([
      {
        name: 'Size',
        required: true,
        options: [
          { label: 'Large', price: 45 },
          { label: 'Small', price: 35 },
        ],
      },
    ])

    expect(unconvertible).toEqual([])
    expect(groups).toEqual([
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: [
          { label: 'Large', price: 45 },
          { label: 'Small', price: 35 },
        ],
      },
    ])
  })

  it('infers type "text" for a typeless group of plain option strings', () => {
    const { groups, unconvertible } = sanitizeVariantGroupsForWrite([
      { name: 'Milk', required: false, options: ['Oat', 'Soy', '  '] },
    ])

    expect(unconvertible).toEqual([])
    expect(groups).toEqual([
      { name: 'Milk', required: false, type: 'text', options: ['Oat', 'Soy'] },
    ])
  })

  it('reads an option label from `name` when `label` is absent, as the reader does', () => {
    const { groups } = sanitizeVariantGroupsForWrite([
      { name: 'Size', required: true, options: [{ id: 'l', name: 'Large', price: 45 }] },
    ])

    expect(groups).toEqual([
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Large', price: 45 }] },
    ])
  })

  it('what it writes is what the READER accepts -- the two halves of #229 agree', () => {
    const { groups } = sanitizeVariantGroupsForWrite([
      { name: 'Size', required: true, options: [{ name: 'Large', price: 45 }] },
    ])

    // The exact call browse/page.tsx and ItemDetailModal make. Before this change the same
    // group, written verbatim, came back as [].
    expect(normalizeVariantGroups(groups)).toEqual([
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Large', price: 45 }] },
    ])
  })
})

describe('#229 sanitizeVariantGroupsForWrite: it never invents money and never loses a row', () => {
  it('preserves a delta-priced production group BYTE FOR BYTE and names it unconvertible', () => {
    const { groups, unconvertible } = sanitizeVariantGroupsForWrite([PROD_REQUIRED_GROUP])

    expect(unconvertible).toEqual(['Size'])
    expect(groups).toEqual([PROD_REQUIRED_GROUP])
    // Not merely deep-equal: nothing was rebuilt, so no field could have been reinterpreted.
    expect(groups[0]).toBe(PROD_REQUIRED_GROUP)
  })

  it('never copies a price_modifier into a price', () => {
    const { groups } = sanitizeVariantGroupsForWrite([PROD_REQUIRED_GROUP])
    const options = (groups[0] as { options: Array<Record<string, unknown>> }).options

    // The N$0.00 default-size trap: 250ml has price_modifier 0 and must not acquire price 0.
    for (const option of options) {
      expect(option).not.toHaveProperty('price')
    }
    expect(options.map((o) => o.price_modifier)).toEqual([0, 10, 15])
  })

  it('a delta-priced group is left alone even when it DECLARES type "price"', () => {
    const declared = { ...PROD_REQUIRED_GROUP, type: 'price' }
    const { groups, unconvertible } = sanitizeVariantGroupsForWrite([declared])

    expect(unconvertible).toEqual(['Size'])
    expect(groups[0]).toBe(declared)
  })

  it('REGRESSION: a legacy group beside a good one is no longer destroyed by an unrelated save', () => {
    const goodGroup = {
      name: 'Milk',
      required: false,
      type: 'text' as const,
      options: ['Oat', 'Soy'],
    }
    const { groups } = sanitizeVariantGroupsForWrite([PROD_REQUIRED_GROUP, goodGroup])

    // The old editor sanitiser cleaned PROD_REQUIRED_GROUP to zero options, filtered it out,
    // and wrote back [goodGroup] -- silently deleting the group the staff member could see.
    expect(groups).toHaveLength(2)
    expect(groups[0]).toBe(PROD_REQUIRED_GROUP)
  })

  it('drops only what could never be rendered, priced or enforced: no name, or no options', () => {
    const { groups, unconvertible } = sanitizeVariantGroupsForWrite([
      { name: '   ', required: true, type: 'text', options: ['A'] },
      { name: 'Empty', required: true, type: 'text', options: [] },
      { name: 'Kept', required: true, type: 'text', options: ['A'] },
    ])

    expect(unconvertible).toEqual([])
    expect(groups).toEqual([{ name: 'Kept', required: true, type: 'text', options: ['A'] }])
  })

  it('a non-array is not an array of groups', () => {
    expect(sanitizeVariantGroupsForWrite(undefined)).toEqual({ groups: [], unconvertible: [] })
    expect(sanitizeVariantGroupsForWrite('Size')).toEqual({ groups: [], unconvertible: [] })
  })
})

describe('#229 the funnel: buildMenuItemDbPayload canonicalises whatever the request body says', () => {
  it('fills in a missing `type` on the snake_case spelling', () => {
    const payload = buildMenuItemDbPayload({
      variant_groups: [{ name: 'Size', required: true, options: [{ name: 'Large', price: 45 }] }],
    })

    expect(payload.variant_groups).toEqual([
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Large', price: 45 }] },
    ])
  })

  it('fills in a missing `type` on the camelCase spelling too -- both write the same column', () => {
    const payload = buildMenuItemDbPayload({
      variantGroups: [{ name: 'Size', required: true, options: [{ name: 'Large', price: 45 }] }],
    })

    expect(payload.variant_groups).toEqual([
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Large', price: 45 }] },
    ])
  })

  it('still writes nothing to the column when the caller mentions neither spelling', () => {
    const payload = buildMenuItemDbPayload({ name: 'Cappucinno' })
    expect('variant_groups' in payload).toBe(false)
  })

  it('does not rewrite a stored production group on its way back through', () => {
    const payload = buildMenuItemDbPayload({ variant_groups: [PROD_REQUIRED_GROUP] })
    expect(payload.variant_groups).toEqual([PROD_REQUIRED_GROUP])
  })
})

describe('#229 MONEY GUARD: this change does not make production variant groups live (#117)', () => {
  const cappucinno = (variantGroups: unknown) => ({
    id: 'e184dfe6-a077-4976-b9f3-286fd48d568b',
    name: 'Cappucinno',
    base_price: 45,
    variants: PROD_LEGACY_VARIANTS,
    variant_groups: variantGroups,
  })

  it('a production group written back through the writer is STILL dropped by the reader', () => {
    const { groups } = sanitizeVariantGroupsForWrite([PROD_REQUIRED_GROUP])
    expect(normalizeVariantGroups(groups)).toEqual([])
  })

  it('the customer is still offered the legacy Large/Small at N$45/N$35, not 250/350/500ml', () => {
    const { groups } = sanitizeVariantGroupsForWrite([PROD_REQUIRED_GROUP])

    expect(getVariantGroups(cappucinno(groups))).toEqual([
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: [
          { label: 'Large', price: 45 },
          { label: 'Small', price: 35 },
        ],
      },
    ])
  })

  it('CONTROL: the same reader DOES surface a group once a human supplies absolute prices', () => {
    // Without this the test above proves only that the reader is broken, not that it is
    // correctly declining to guess. This is the state a hand migration would produce.
    const migrated = sanitizeVariantGroupsForWrite([
      {
        ...PROD_REQUIRED_GROUP,
        options: [
          { id: '250ml', name: '250ml', price: 45 },
          { id: '350ml', name: '350ml', price: 55 },
          { id: '500ml', name: '500ml', price: 60 },
        ],
      },
    ])

    expect(migrated.unconvertible).toEqual([])
    expect(getVariantGroups(cappucinno(migrated.groups))[0].options).toEqual([
      { label: '250ml', price: 45 },
      { label: '350ml', price: 55 },
      { label: '500ml', price: 60 },
    ])
  })
})

describe('#228 findMissingRequiredVariantGroups: enforceable on the RAW stored shape', () => {
  it('reports a required group the reader drops -- which is the whole point of the issue', () => {
    // isRequiredVariantMissing() iterates getVariantGroups(), which discards this group, so the
    // shipped client check cannot see it at all.
    expect(findMissingRequiredVariantGroups([PROD_REQUIRED_GROUP], {})).toEqual(['Size'])
  })

  it('is satisfied by a non-empty selection under the group NAME', () => {
    expect(findMissingRequiredVariantGroups([PROD_REQUIRED_GROUP], { Size: '350ml' })).toEqual([])
  })

  it('SEAM HAZARD: a selection keyed by a different name does NOT satisfy it', () => {
    // Live today: browse falls back to the legacy column and synthesises a group literally named
    // "Size", so the client sends { Size: 'Large' } and this happens to pass. An item whose
    // stored group is named anything else -- "Volume" -- would be refused for a customer who has
    // no way to answer it, because no surface renders that group. This is why #228's enforcement
    // must not be wired before the stored rows are migrated.
    expect(findMissingRequiredVariantGroups([{ ...PROD_REQUIRED_GROUP, name: 'Volume' }], {
      Size: 'Large',
    })).toEqual(['Volume'])
  })

  it('ignores optional groups, and blank or whitespace-only answers count as unanswered', () => {
    expect(
      findMissingRequiredVariantGroups(
        [
          { name: 'Milk', required: false, options: ['Oat'] },
          { name: 'Size', required: true, options: ['Large'] },
        ],
        { Size: '   ' },
      ),
    ).toEqual(['Size'])
  })

  it('never reports a required group with no options -- nothing could ever satisfy it', () => {
    expect(findMissingRequiredVariantGroups([{ name: 'Size', required: true, options: [] }], {})).toEqual(
      [],
    )
  })

  it('tolerates rubbish where the column or the selection should be', () => {
    expect(findMissingRequiredVariantGroups(null, {})).toEqual([])
    expect(findMissingRequiredVariantGroups([PROD_REQUIRED_GROUP], null)).toEqual(['Size'])
    expect(findMissingRequiredVariantGroups([PROD_REQUIRED_GROUP], ['Size'])).toEqual(['Size'])
  })
})
