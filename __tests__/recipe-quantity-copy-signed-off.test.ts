/**
 * The four recipe-quantity strings, SIGNED 2026-08-27, pinned character for character.
 *
 * THEY RENDERED AS `[PLACEHOLDER: ...]` ON PRODUCTION, to a live venue, in the menu editor's
 * Inventory tab. The placeholder gate matches `PENDING COPY` / `COPY PENDING` and had never heard
 * of `PLACEHOLDER` — a third spelling of the same convention, in a file no per-string test covered.
 *
 * THEY LIVE IN TWO FILES, deliberately identical: the menu-item Inventory tab and the standalone
 * recipe editor show the same fields, so a merchant meets the same wording either way. Both are
 * asserted here against ONE source of truth, because two copies of a signed string is exactly how
 * one of them quietly drifts.
 */
import { readFileSync } from 'node:fs'

const FILES = [
  'components/menu/menu-item-inventory-tab.tsx',
  'components/recipes/recipe-editor-form.tsx',
] as const

const SIGNED = {
  label: 'Quantity used per single sale',
  equals_on_hand:
    'this is exactly what you have in stock. did you mean how much one sale uses? as entered, selling one would take the whole lot.',
  exceeds_on_hand:
    'this is more than you have in stock. as entered, the first sale takes the balance below zero.',
  one_to_one_not_single:
    'this ingredient is the same item being sold, so one sale would normally use 1. that is fine if the stock item is counted in smaller pieces - a 25ml tot from a 750ml bottle, for example.',
} as const

/** Source with block and line comments removed — the docblocks legitimately discuss placeholders. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

describe('recipe-quantity copy — signed 2026-08-27', () => {
  it.each(FILES)('%s carries all four signed strings verbatim', (file) => {
    const src = code(file)
    for (const text of Object.values(SIGNED)) {
      expect(src).toContain(text)
    }
  })

  it.each(FILES)('%s carries no PLACEHOLDER marker in shippable code', (file) => {
    // Docblock prose about the incident is fine and is stripped above; a marker in a rendered
    // string is not.
    expect(code(file)).not.toMatch(/\[\s*PLACEHOLDER/i)
    expect(code(file)).not.toMatch(/PLACEHOLDER\s+COPY/i)
  })

  it('keeps exceeds_on_hand BLUNT — a consequence, not a question', () => {
    // Ruled deliberately. It is the Mingle nine caught at entry: a delivery count typed into a
    // per-sale field, where one sale consumed the whole delivery. A question invites the merchant
    // to decide they are probably fine; a stated consequence does not.
    expect(SIGNED.exceeds_on_hand).not.toContain('?')
    expect(SIGNED.exceeds_on_hand).toContain('below zero')
  })

  it('keeps the two heuristics as QUESTIONS, because the merchant may well be right', () => {
    expect(SIGNED.equals_on_hand).toContain('?')
    // one_to_one_not_single states a norm and then excuses the exception rather than accusing.
    expect(SIGNED.one_to_one_not_single).toContain('that is fine if')
  })

  it('names the 25ml tot in one_to_one_not_single, for the bar manager who will hit it', () => {
    // Riviera pours a 25ml tot from a 750ml bottle. That IS "the ingredient is the item itself"
    // with a quantity that is not 1, and it is correct. Without the example a bar manager reads a
    // warning about their own normal setup and wonders what they got wrong.
    expect(SIGNED.one_to_one_not_single).toContain('25ml tot from a 750ml bottle')
    expect(SIGNED.one_to_one_not_single).toContain('smaller pieces')
  })

  it('says the quantity is what ONE sale uses, which is the whole point of the field', () => {
    expect(SIGNED.label).toContain('per single sale')
  })

  it('uses an ASCII hyphen, never an em or en dash', () => {
    // A smart-quotes pass is a silent reword of signed copy.
    for (const text of Object.values(SIGNED)) {
      expect(text).not.toMatch(/[–—]/)
    }
  })

  it('THE TWO FILES DO NOT DRIFT — identical strings, asserted against each other', () => {
    const [a, b] = FILES.map(code)
    for (const text of Object.values(SIGNED)) {
      expect(a.includes(text)).toBe(b.includes(text))
    }
  })
})
