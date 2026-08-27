/**
 * #360 — a free option (`price: 0`) is a first-class thing the editor can save.
 *
 * THE DEFECT. The writer's `price > 0` filter discarded any option priced at zero. Five Mingle
 * items — Flavoured dalgona, Flavoured ice coffee, Milkshake, 500ml Radler, Clausthaler — carry
 * flavour lists where every option is `{name, price: 0}`, because a flavour choice is free. The
 * venue entered its menu correctly and the software silently threw it away, so customers were
 * offered NO choices at all on five live items. The owner: *"That is the defect — not their data."*
 *
 * THE DISCRIMINATOR IS THE LABEL, NOT THE PRICE, and #229 is why it has to be.
 *
 * #229 needs a half-filled row NOT to ship: Cappucinno carries a blank third option for the venue
 * to fill in, and if a blank row were saved as priced it would put a FREE size in front of
 * customers. Price cannot separate "free on purpose" from "not filled in yet" — both are
 * absent-or-zero. A label is something a person typed, and its presence is the intent a zero
 * cannot express.
 *
 *     label present, price 0        -> SAVE, a free option
 *     label blank,   price blank    -> blank placeholder, kept for the venue to fill
 *     label blank,   price present  -> DROP, a half-filled row
 *     label present, price absent   -> DROP, indistinguishable from free once zero is legitimate
 *
 * EACH CASE IS TESTED BESIDE A KNOWN-GOOD OPTION. A group that canonicalises to no labelled option
 * is preserved verbatim as `unconvertible`, which looks identical to "the option was kept" — so a
 * single-option fixture can tell you nothing about the discriminator. That mistake was made and
 * corrected while writing this.
 */
import { normalizeVariantGroups, sanitizeVariantGroupsForWrite } from '@/lib/menu/variant-groups'

type Opt = Record<string, unknown>
const KEEPER = { label: 'Vanilla', price: 0 }

function writeBeside(option: unknown): Opt[] {
  const result = sanitizeVariantGroupsForWrite([
    { id: 'flavour', name: 'Flavour', type: 'price', required: false, options: [KEEPER, option] },
  ]) as { groups: Array<{ options: Opt[] }> }
  return (result.groups[0]?.options ?? []).filter((o) => o?.label !== 'Vanilla')
}

describe('#360 a free option is first-class', () => {
  it('SAVES a labelled option priced at zero', () => {
    expect(writeBeside({ label: 'Hazelnut', price: 0 })).toEqual([{ label: 'Hazelnut', price: 0 }])
  })

  it("SAVES the legacy {name, price: 0} shape — the five Mingle items' actual data", () => {
    // `getItemVariants` requires size AND label, so this shape read as [] and the items rendered
    // with no choices at all. The writer must be able to round-trip it.
    expect(writeBeside({ name: 'Bubblegum', price: 0 })).toEqual([{ label: 'Bubblegum', price: 0 }])
  })

  it('KEEPS a fully blank row as a placeholder for the venue to fill', () => {
    expect(writeBeside({ label: '', price: null })).toEqual([{ label: '', price: null }])
  })

  it('DROPS a priced row with no label — a half-filled row, not an option', () => {
    expect(writeBeside({ label: '', price: 12 })).toEqual([])
  })

  it('DROPS a labelled row with NO price, because zero is now legitimate', () => {
    // Before #360 this was dropped so a `Number(null) === 0` would not ship a free size by
    // accident. It is still dropped, for a sharper reason: a stored `{label:'Medium', price:null}`
    // now reads as a deliberate free Medium and we cannot tell whether that was intended. An
    // EXPLICIT number is what makes an option free.
    expect(writeBeside({ label: 'Medium' })).toEqual([])
  })

  it('an explicit price of 0 and an ABSENT price are not the same thing', () => {
    // `Number(null)` is 0 and `Number('')` is 0. Coercing before inspecting collapses "left blank"
    // into "costs nothing" — which is exactly what broke #229's blank row when `price > 0` was
    // relaxed, and is why the raw value is checked first.
    expect(writeBeside({ label: 'A', price: 0 })).toEqual([{ label: 'A', price: 0 }])
    expect(writeBeside({ label: 'A', price: null })).toEqual([])
    expect(writeBeside({ label: 'A', price: '' })).toEqual([])
  })

  it('the reader keeps free options rather than filtering them out', () => {
    const groups = normalizeVariantGroups([
      {
        id: 'flavour', name: 'Flavour', type: 'price', required: false,
        options: [{ label: 'Hazelnut', price: 0 }, { label: 'Salted caramel', price: 0 }],
      },
    ])
    expect(groups[0].options).toEqual([
      { label: 'Hazelnut', price: 0 },
      { label: 'Salted caramel', price: 0 },
    ])
  })
})

describe("#360 must not break #229's blank row", () => {
  const CAPPUCINNO = [
    {
      id: 'size', name: 'Size', type: 'price', required: true,
      options: [
        { label: 'Large', price: 45 },
        { label: 'Small', price: 35 },
        { label: '', price: null },
      ],
    },
  ]

  it('writes the blank third row through, in position', () => {
    const out = sanitizeVariantGroupsForWrite(CAPPUCINNO) as { groups: Array<{ options: Opt[] }> }
    expect(out.groups[0].options).toEqual([
      { label: 'Large', price: 45 },
      { label: 'Small', price: 35 },
      { label: '', price: null },
    ])
  })

  it('and the READER drops it, so it can never be selected, defaulted to, or charged', () => {
    const out = sanitizeVariantGroupsForWrite(CAPPUCINNO) as { groups: unknown[] }
    expect(normalizeVariantGroups(out.groups)[0].options).toEqual([
      { label: 'Large', price: 45 },
      { label: 'Small', price: 35 },
    ])
  })

  it('THE POINT OF IT: a blank row never reaches a customer as a FREE size', () => {
    // The failure this guards is specific and expensive: a half-filled size row shipping at N$0.
    const out = sanitizeVariantGroupsForWrite(CAPPUCINNO) as { groups: unknown[] }
    const read = normalizeVariantGroups(out.groups)[0].options as Opt[]
    expect(read.filter((o) => Number(o.price) === 0)).toEqual([])
    expect(read).toHaveLength(2)
  })
})
