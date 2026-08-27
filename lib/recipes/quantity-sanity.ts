/**
 * Detects a recipe quantity that has been entered as a STOCK COUNT rather than as the amount
 * consumed per single unit sold.
 *
 * Why this exists, measured on production 2026-08-26:
 *
 * Nine live Mingle recipes carry a quantity that is exactly the quantity that was received
 * into stock for that same item — not a coincidence, a one-for-one match on all nine:
 *
 *     Wedge biscuits   received 30 on 08-06   recipe quantity 30
 *     Powerade         received 24 on 08-06   recipe quantity 24
 *     Sausage roll     received 20 on 08-06   recipe quantity 20
 *     popcorn          received 20 on 08-06   recipe quantity 20
 *     Mckane dry lemon received 12 on 08-06   recipe quantity 12
 *     Mckane Lemonade  received 12 on 08-06   recipe quantity 12
 *     Mckane soda water received 12 on 08-06  recipe quantity 12
 *     Mckane tonic water received 12 on 08-06 recipe quantity 12
 *     Single brownie   received 10 on 08-05   recipe quantity 10
 *
 * Three of them then self-destructed in the ledger within hours, a single sale wiping the whole
 * delivery: Wedge biscuits `received:30` then `sale:-30`; Powerade `received:24` then `sale:-24`;
 * Mckane Lemonade `received:12` then `sale:-12`. Each was followed by a manual recount, and
 * tracking was switched off for all nine — which is how a merchant "fixes" this today.
 *
 * The field accepted a delivery count where a per-serving amount belongs, with no warning. That
 * is what this module makes impossible to do silently.
 *
 * DELIBERATELY ADVISORY. Every signal here is a heuristic about intent, and a legitimate recipe
 * can trip one — five chicken wings per portion, thirty grams of beans per cup. So this returns
 * warnings to show, never a reason to refuse a save. Blocking a merchant out of their own recipe
 * on a guess is a worse failure than the one being prevented.
 */

/** One ingredient line as the editor holds it, plus whatever context the surface can supply. */
export type RecipeQuantityLine = {
  stockItemId: string
  /** As typed. Non-numeric or blank input is ignored rather than guessed at. */
  quantity: number | string
  /** Name of the linked stock item, when the surface knows it. */
  stockItemName?: string | null
  /**
   * Ledger balance for the linked stock item, when the surface knows it. `null`/undefined means
   * "not available here", which suppresses the balance-derived signals rather than assuming 0 —
   * an assumed zero would fire on every line in a surface that simply does not load balances.
   */
  currentStock?: number | null
}

export type RecipeQuantityWarningCode =
  /** Quantity is exactly the amount on hand. The fingerprint of a delivery count. */
  | 'equals_on_hand'
  /** Quantity is greater than the amount on hand: the first sale drives the balance negative. */
  | 'exceeds_on_hand'
  /**
   * A single-ingredient recipe whose stock item is the same thing as the menu item — a bottle of
   * Coke sold as a Coke — carrying a quantity other than 1. Selling one can only consume one.
   *
   * WEAK, and used only as a fallback where no balance is available. On its own this signal is
   * wrong about real recipes: FNB ChowNow sells "Chicken Wings" from a stock item also called
   * "Chicken Wings" at 5 per portion, and the ledger shows that working exactly as intended —
   * received 50, three sales of -5, balance still 35. Name equality does not establish that the
   * stock item is counted in the same unit the menu item is sold in.
   */
  | 'one_to_one_not_single'

export type RecipeQuantityWarning = {
  stockItemId: string
  code: RecipeQuantityWarningCode
  quantity: number
  /** Present only for the balance-derived codes. */
  currentStock: number | null
}

/**
 * Loose name equality, so "Coke" matches "Coke Zero"'s sibling "Coke zero" only when it really is
 * the same string once case, spacing and separators are set aside. Kept deliberately strict about
 * content — it removes punctuation and case, nothing else — because a false "same thing" reading
 * would warn on a genuine multi-word ingredient.
 */
function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function sameThing(menuItemName: string, stockItemName: string): boolean {
  const a = normaliseName(menuItemName)
  const b = normaliseName(stockItemName)
  if (!a || !b) return false
  return a === b
}

/**
 * @param menuItemName the item being sold, used only for the one-to-one signal.
 * @param lines the ingredient rows as currently entered.
 * @returns one warning per offending line, in the order the lines were given. A line can produce
 *          at most one warning: the signals overlap heavily (a delivery count is usually both
 *          "equals on hand" and "not 1 on a 1:1"), and reporting the same mistake three times
 *          reads as three mistakes.
 */
export function findRecipeQuantityWarnings(
  menuItemName: string,
  lines: RecipeQuantityLine[],
): RecipeQuantityWarning[] {
  const warnings: RecipeQuantityWarning[] = []

  // The one-to-one signal is only meaningful when this stock item is the ONLY thing the recipe
  // consumes. A croissant that takes one croissant and one rasher of bacon is a real recipe;
  // the quantity on either line carries no expectation of being 1.
  const usableLines = lines.filter((line) => {
    const quantity = Number(line.quantity)
    return Boolean(line.stockItemId) && Number.isFinite(quantity) && quantity > 0
  })
  const isSingleIngredient = usableLines.length === 1

  for (const line of usableLines) {
    const quantity = Number(line.quantity)
    const hasBalance =
      line.currentStock !== null &&
      line.currentStock !== undefined &&
      Number.isFinite(line.currentStock)
    const currentStock = hasBalance ? Number(line.currentStock) : null

    // Ordered most-specific first. `equals_on_hand` is the strongest evidence of a miskeyed
    // delivery count, so it wins over the weaker signals when several apply.
    //
    // The `continue`s below are defensive, not load-bearing: with today's three signals no line
    // can satisfy two of them (equals_on_hand needs quantity === currentStock, which rules out
    // exceeds_on_hand; and both need a balance, which one_to_one_not_single rules out). Removing
    // them fails no test, and that was verified rather than assumed. They are kept so that
    // "one warning per line" survives a fourth signal being added later.
    if (currentStock !== null && quantity > 1 && quantity === currentStock) {
      warnings.push({ stockItemId: line.stockItemId, code: 'equals_on_hand', quantity, currentStock })
      continue
    }

    if (currentStock !== null && quantity > currentStock) {
      warnings.push({ stockItemId: line.stockItemId, code: 'exceeds_on_hand', quantity, currentStock })
      continue
    }

    // Fallback only. Where a balance IS known, the two signals above have already had their say
    // and a quiet result means the line looked fine against real numbers — saying "but the names
    // match" on top of that is how a warning earns its way into being ignored.
    if (
      currentStock === null &&
      isSingleIngredient &&
      quantity !== 1 &&
      line.stockItemName &&
      sameThing(menuItemName, line.stockItemName)
    ) {
      warnings.push({
        stockItemId: line.stockItemId,
        code: 'one_to_one_not_single',
        quantity,
        currentStock,
      })
    }
  }

  return warnings
}
