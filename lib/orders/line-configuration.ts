/**
 * What the customer actually configured on a line, as one short string. (#298)
 *
 * THE DEFECT THIS EXISTS FOR. #297 proved that two "Beef Burger" lines at N$130 and N$107 were
 * one item in two configurations -- 95 + `Extra patty` 35, and 95 + `Cheese` 12. The prices were
 * right. The screen rendered only the item NAME, so it read as FlashTap charging two different
 * prices for the same burger. The add-on is the thing that distinguishes the lines and it was the
 * one thing not drawn.
 *
 * NO NEW WORDING. This returns the customer's own selections, joined. It invents no labels and
 * no explanation -- rendering what somebody configured is data, not copy. The cart's existing
 * labelled treatment ("Size:", "Add-ons:") is signed-off wording and is left alone; this is for
 * the six surfaces that showed nothing at all.
 *
 * TWO STORED SHAPES, on purpose. A line read back from `orders.items` / `order_requests.items`
 * uses `size` / `addons` / `selectedVariants`. A line held in the browser cart uses
 * `selected_size` / `selected_addons` / `selected_variants`, and its size is an object rather
 * than a string. Both are accepted, because the alternative is each render site doing its own
 * shape-sniffing and getting it subtly different -- which is how the price sweep in #295 found
 * six surfaces disagreeing.
 */

type AddonLike = { name?: unknown; price?: unknown } | string

/**
 * Every field is `unknown` on purpose.
 *
 * These are read straight off a stored JSONB line, so the compiler has never seen their real
 * shape and a narrower type here would only push casts out to six call sites. Validation happens
 * below, once, where it can be read.
 */
export type ConfigurableLine = {
  size?: unknown
  selected_size?: unknown
  addons?: unknown
  selected_addons?: unknown
  selectedVariants?: unknown
  selected_variants?: unknown
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && 'name' in value) {
    const name = (value as { name?: unknown }).name
    if (typeof name === 'string') return name.trim()
  }
  return ''
}

function sizeName(line: ConfigurableLine): string {
  return textOf(line.size) || textOf(line.selected_size)
}

function addonNames(line: ConfigurableLine): string[] {
  const raw = Array.isArray(line.addons)
    ? line.addons
    : Array.isArray(line.selected_addons)
      ? line.selected_addons
      : []
  return (raw as AddonLike[]).map(textOf).filter(Boolean)
}

/**
 * Variant selections, as values only.
 *
 * The GROUP name is deliberately not rendered. `{"Milk": "Oat"}` reads as "Oat", not
 * "Milk: Oat" -- the value is what the customer picked and the group is the question they were
 * asked. Where a group allows several picks the array is flattened in order.
 */
function variantValues(line: ConfigurableLine): string[] {
  const raw = (line.selectedVariants ?? line.selected_variants) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        const t = textOf(v)
        if (t) out.push(t)
      }
    } else {
      const t = textOf(value)
      if (t) out.push(t)
    }
  }
  return out
}

/**
 * One line's configuration, or `''` when the customer configured nothing.
 *
 * Empty string rather than a placeholder: a line with no size, no add-ons and no variants has
 * nothing to say, and saying something anyway would put a word on screen for every plain item.
 * Callers render the row only when this is non-empty.
 *
 * Order is size, then variants, then add-ons -- broadest choice first, matching how the item
 * sheet asks for them.
 */
export function lineConfigurationSummary(line: ConfigurableLine | null | undefined): string {
  if (!line || typeof line !== 'object') return ''
  const parts = [sizeName(line), ...variantValues(line), ...addonNames(line)].filter(Boolean)
  // De-duplicated: a size echoed into the variants map would otherwise print twice.
  return [...new Set(parts)].join(' · ')
}
