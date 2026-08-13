/**
 * "A", "A and B", "A, B and C" — the way item names are joined in a refusal a customer reads.
 *
 * Extracted so the two refusals a customer can hit for the same cart phrase their lists
 * identically: `checkStockSufficiency` ("… is out of stock") and `calculateOrderPricing`
 * ("… no longer on the menu", #273). They were one function and one copy of this rule; the
 * second refusal was about to grow its own, and two list-formatters drift in punctuation the
 * moment either is edited.
 */
export function listNames(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
