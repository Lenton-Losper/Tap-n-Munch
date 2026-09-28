/**
 * VARIANTS ON THE TERMINAL — the pure half. Sprint 2026-09-28 brief.
 *
 * The server is the authority on what a line costs: POST /api/terminal/orders and
 * POST /api/terminal/rounds reprice every line from the catalog and ignore the client's figure.
 * Everything here is DISPLAY and IDENTITY only, and it has one job: show the waiter exactly the
 * number the server is about to charge, and never put two different selections on one line.
 *
 * ================================================================================================
 * WHAT IT MIRRORS, AND FROM WHERE
 * ================================================================================================
 *
 * Web: lib/menu/variant-groups.ts (findSelectedVariantPrice, getItemDisplayPrice,
 * isRequiredVariantMissing, buildVariantDisplayName) and lib/orders/calculate-order-pricing.ts
 * (priceCatalogLine). Read, not inferred:
 *
 *   - A 'price' option is ABSOLUTE. It REPLACES base_price; it is not added to it.
 *   - The FIRST price-typed group whose selected option matches wins. A second priced group that
 *     also matched does NOT add to it -- the server has no additive variant group. (Additive money
 *     exists only as `menu_items.sizes` / `addons`, which the terminal does not send.) Showing a sum
 *     here would display a figure the server never charges.
 *   - A 'text' group never moves the price.
 *   - No match -> base_price. That fallback is exactly why a required priced group left unanswered
 *     must never be DISPLAYED as a price: on a zero-base item it would read N$0.00.
 *
 * The groups themselves arrive already resolved by the server (C6 `resolved_variant_groups`,
 * computed by getVariantGroups), so the terminal does not reimplement the legacy-column fallback
 * or normalisation -- it shows what the server will price.
 */

export type VariantGroupType = 'price' | 'text';

export interface VariantOption {
  label: string;
  /** Absolute price for a 'price' group. Always null on a 'text' group, which never prices. */
  price: number | null;
}

export interface VariantGroup {
  name: string;
  required: boolean;
  type: VariantGroupType;
  options: VariantOption[];
}

/** `{ groupName: optionLabel }` -- the shape the QR cart sends and C6 names. */
export type VariantSelection = Record<string, string>;

/** Anything carrying the fields the pricing reads. MenuItem satisfies it. */
export interface VariantPricedItem {
  id: string;
  name: string;
  base_price: number;
  /** null/undefined = the server did not say (an older server): treated as "no groups known". */
  variant_groups?: VariantGroup[] | null;
}

function toFiniteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * C6 `resolved_variant_groups` -> VariantGroup[].
 *
 * Returns NULL, not [], when the field is absent or not an array. The difference matters: [] is
 * the server saying "this item has no options"; null is an older server that says nothing. Both
 * keep the one-tap flow (the server is the authority and refuses with C5 if something was
 * required), but only one of them is a fact.
 *
 * Defensive in the same places normalizeVariantGroups is: a group with no name, no recognised
 * type, or no usable option is dropped; a 'price' option without a finite price is dropped (the
 * server drops it too, so offering it would offer something unchargeable).
 */
export function mapResolvedVariantGroups(raw: unknown): VariantGroup[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const groups: VariantGroup[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const g = entry as Record<string, unknown>;
    const name = String(g.name ?? '').trim();
    const type: VariantGroupType | null =
      g.type === 'price' ? 'price' : g.type === 'text' ? 'text' : null;
    if (!name || !type || !Array.isArray(g.options)) {
      continue;
    }
    const options: VariantOption[] = [];
    for (const opt of g.options) {
      let label = '';
      let price: number | null = null;
      if (typeof opt === 'string') {
        label = opt.trim();
      } else if (opt && typeof opt === 'object') {
        const o = opt as Record<string, unknown>;
        label = String(o.label ?? o.name ?? '').trim();
        price = toFiniteOrNull(o.price);
      }
      if (!label) {
        continue;
      }
      if (type === 'price') {
        if (price === null) {
          continue;
        }
        options.push({label, price});
      } else {
        options.push({label, price: null});
      }
    }
    if (options.length === 0) {
      continue;
    }
    groups.push({name, required: Boolean(g.required), type, options});
  }
  return groups;
}

export function variantGroupsOf(item: VariantPricedItem): VariantGroup[] {
  return Array.isArray(item.variant_groups) ? item.variant_groups : [];
}

/** True when the waiter has to be asked something before this item can be added. */
export function hasVariantChoices(item: VariantPricedItem): boolean {
  return variantGroupsOf(item).length > 0;
}

/**
 * The selection reduced to what the server will accept: only groups the item has, only options
 * those groups offer, values trimmed, in GROUP ORDER. Anything else is dropped rather than sent --
 * the server refuses an unknown group or option, and the picker can never produce one.
 */
export function canonicalSelection(
  item: VariantPricedItem,
  selection: VariantSelection | null | undefined,
): VariantSelection {
  const out: VariantSelection = {};
  if (!selection) {
    return out;
  }
  for (const group of variantGroupsOf(item)) {
    const chosen = String(selection[group.name] ?? '').trim();
    if (!chosen) {
      continue;
    }
    if (group.options.some(o => o.label === chosen)) {
      out[group.name] = chosen;
    }
  }
  return out;
}

/**
 * Every required group answered with one of its own options. The Add button's gate.
 *
 * Judged on the CANONICAL selection, so an answer that is not a real option does not count as an
 * answer -- the server would refuse it as unknown.
 */
export function isSelectionComplete(
  item: VariantPricedItem,
  selection: VariantSelection | null | undefined,
): boolean {
  const canonical = canonicalSelection(item, selection);
  return variantGroupsOf(item).every(
    group => !group.required || canonical[group.name] !== undefined,
  );
}

/**
 * Mirror of findSelectedVariantPrice + getItemDisplayPrice: the first price-typed group whose
 * selected option matches REPLACES base_price; otherwise base_price.
 */
export function variantUnitPrice(
  item: VariantPricedItem,
  selection: VariantSelection | null | undefined,
): number {
  const canonical = canonicalSelection(item, selection);
  for (const group of variantGroupsOf(item)) {
    if (group.type !== 'price') {
      continue;
    }
    const chosen = canonical[group.name];
    if (chosen === undefined) {
      continue;
    }
    const option = group.options.find(o => o.label === chosen);
    if (option && option.price !== null) {
      return option.price;
    }
  }
  const base = Number(item.base_price);
  return Number.isFinite(base) ? base : 0;
}

/**
 * The unit price to SHOW, or null when it cannot honestly be shown yet.
 *
 * Null while a required group is unanswered: the server's fallback for "nothing matched" is
 * base_price, which on a zero-base item is N$0.00 -- a figure the server will never actually
 * charge, because it refuses the line instead. So the picker says "choose" rather than a price.
 */
export function displayUnitPrice(
  item: VariantPricedItem,
  selection: VariantSelection | null | undefined,
): number | null {
  if (!isSelectionComplete(item, selection)) {
    return null;
  }
  return variantUnitPrice(item, selection);
}

/**
 * The range a menu tile can truthfully show before anything is chosen.
 *
 * Only the FIRST price group can set the price when answered (first match wins), but a first
 * group left unanswered hands pricing to the next one, so every price option of every price group
 * is a price the waiter could end up charging. base_price is reachable only when no price group
 * is required -- otherwise the server refuses rather than falling back to it, and on a zero-base
 * item including it would put "from N$0.00" on the tile.
 */
export function priceRange(item: VariantPricedItem): {min: number; max: number} {
  const base = Number.isFinite(Number(item.base_price)) ? Number(item.base_price) : 0;
  const priceGroups = variantGroupsOf(item).filter(g => g.type === 'price');
  if (priceGroups.length === 0) {
    return {min: base, max: base};
  }
  const prices: number[] = [];
  for (const group of priceGroups) {
    for (const option of group.options) {
      if (option.price !== null) {
        prices.push(option.price);
      }
    }
  }
  if (!priceGroups.some(g => g.required)) {
    prices.push(base);
  }
  return {min: Math.min(...prices), max: Math.max(...prices)};
}

/** "N$35.00" or "N$35.00 – N$45.00". */
export function formatPriceRange(item: VariantPricedItem, currency = 'N$'): string {
  const {min, max} = priceRange(item);
  return min === max
    ? `${currency}${min.toFixed(2)}`
    : `${currency}${min.toFixed(2)} – ${currency}${max.toFixed(2)}`;
}

/**
 * The line identity. TWO SIZES ARE TWO LINES: merging a Small into a Large would charge one of
 * them at the other's price, and send the kitchen one size twice.
 *
 * An item with NO selection keys on its menu item id alone, which is what every line was keyed
 * on before variants existed -- so a plain item behaves exactly as it always has, including for
 * callers that pass the menu item id to updateQuantity. Entries are sorted so the key does not
 * depend on the order a selection object was built in.
 */
export function variantLineKey(
  menuItemId: string,
  selection: VariantSelection | null | undefined,
): string {
  const entries = Object.entries(selection ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([k, v]) => [k, v.trim()] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) {
    return menuItemId;
  }
  return `${menuItemId}|${JSON.stringify(entries)}`;
}

export function hasSelection(selection: VariantSelection | null | undefined): boolean {
  return Object.values(selection ?? {}).some(v => typeof v === 'string' && v.trim() !== '');
}

/**
 * "Americano - Large", or "Americano - Large / Oat". Mirror of the web's buildVariantDisplayName,
 * which is what the server writes onto the line for stations, receipts and history -- so the
 * waiter's basket reads exactly like the ticket the kitchen gets.
 */
export function variantDisplayName(
  itemName: string,
  selection: VariantSelection | null | undefined,
): string {
  const parts = Object.values(selection ?? {}).filter(
    v => typeof v === 'string' && v.trim() !== '',
  );
  return parts.length > 0 ? `${itemName} - ${parts.join(' / ')}` : itemName;
}

/** "Large / Oat" for an existing order row's `selectedVariants`, or undefined. */
export function variantSummary(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim()) {
      parts.push(first.trim());
    }
  }
  return parts.length > 0 ? parts.join(' / ') : undefined;
}
