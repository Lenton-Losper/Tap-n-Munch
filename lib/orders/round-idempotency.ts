/**
 * CONTRACT C4 -- AN IDEMPOTENCY KEY NAMES ONE BODY, NOT ONE SEND BUTTON.
 *
 * Riviera Table 1, order #160 (Sprint 2026-09-28 brief). The terminal keeps one idempotency key
 * through basket edits after a failed or timed-out Send. The re-send carried an EDITED body -- an
 * item removed -- and createOrder's 23505 branch handed back the ORIGINAL order, which the rounds
 * route then answered as a successful duplicate (or, when the lines had never been written, built
 * lines for from the original items). The waiter saw "Round sent" for the basket on screen; the
 * kitchen got the one from before the edit, including the item they had taken off.
 *
 * A replay is only a replay if it asks for the same thing. So a key that comes back is compared
 * with what the server holds for it:
 *
 *   same fingerprint      -> the same round; answered as a duplicate with what is persisted.
 *   different fingerprint -> 409 IDEMPOTENCY_KEY_BODY_MISMATCH, with what the server actually has,
 *                            so the device can show the waiter the truth instead of their basket.
 *
 * THE FINGERPRINT is the canonical, sorted list of (menuItemId, quantity, note, selectedVariants)
 * per item. It is read with the same field spellings and normalisation the server applies when it
 * prices and stores an item (calculate-order-pricing: quantity <= 0 or non-numeric is 1; the note
 * keys order-lines reads; `selectedVariants` / `selected_variants`, first string of an array), so a
 * body and the order it produced compare equal. Variant names and labels compare case- and
 * whitespace-insensitively: the server may store a canonical spelling of what the device sent, and
 * a byte difference in "Large" vs "large" is not a different round. An absent selection and an
 * empty one are the same.
 */

type Item = Record<string, unknown>

const NOTE_KEYS = [
  'note',
  'notes',
  'lineNote',
  'line_note',
  'specialInstructions',
  'special_instructions',
  'instructions',
] as const

function menuItemIdOf(item: Item): string {
  return String(item.menuItemId ?? item.menu_item_id ?? '').trim().toLowerCase()
}

function quantityOf(item: Item): number {
  const q = Number(item.quantity)
  return Number.isFinite(q) && q > 0 ? q : 1
}

function noteOf(item: Item): string {
  for (const key of NOTE_KEYS) {
    const v = item[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

function variantsOf(item: Item): Array<[string, string]> {
  const raw = item.selectedVariants ?? item.selected_variants
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: Array<[string, string]> = []
  for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string' && first.trim()) {
      out.push([group.trim().toLowerCase(), first.trim().toLowerCase()])
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** One canonical string per item, sorted -- order of items in the basket is not meaningful. */
export function roundItemFingerprint(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items
    .map((raw) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Item
      return JSON.stringify([menuItemIdOf(item), quantityOf(item), noteOf(item), variantsOf(item)])
    })
    .sort()
}

export function sameRoundItems(a: unknown, b: unknown): boolean {
  const fa = roundItemFingerprint(a)
  const fb = roundItemFingerprint(b)
  return fa.length === fb.length && fa.every((v, i) => v === fb[i])
}

/** What the server holds for a key, in a shape the device can show. */
export function persistedItemsSummary(items: unknown) {
  if (!Array.isArray(items)) return []
  return items.map((raw) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Item
    const variants = item.selectedVariants ?? item.selected_variants
    return {
      menuItemId: String(item.menuItemId ?? item.menu_item_id ?? '') || null,
      name: String(item.displayName ?? item.name ?? '').trim() || null,
      quantity: quantityOf(item),
      note: noteOf(item) || null,
      selectedVariants:
        variants && typeof variants === 'object' && !Array.isArray(variants) ? variants : null,
    }
  })
}

export type IdempotentOrder = {
  id: string
  order_number: number | null
  tab_id: string | null
  items: unknown
}

/**
 * The order already holding this key at this venue, or null. Scoped to the venue for the same
 * reason createOrder's own 23505 lookup is (F12 rescoped the unique index per restaurant).
 */
export async function findOrderByIdempotencyKey(
  supabase: { from: (table: string) => any },
  restaurantId: string,
  idempotencyKey: string,
): Promise<IdempotentOrder | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_number, tab_id, items')
    .eq('restaurant_id', restaurantId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (error) throw error
  return data ? (data as IdempotentOrder) : null
}

/** True when the request is a genuine replay of `stored`: same tab (when given) and same items. */
export function isSameRound(
  stored: IdempotentOrder,
  request: { tabId?: string | null; items: unknown },
): boolean {
  if (request.tabId !== undefined && String(stored.tab_id ?? '') !== String(request.tabId ?? '')) {
    return false
  }
  return sameRoundItems(stored.items, request.items)
}

export const IDEMPOTENCY_KEY_BODY_MISMATCH = 'IDEMPOTENCY_KEY_BODY_MISMATCH'

export function idempotencyMismatchBody(stored: IdempotentOrder) {
  return {
    code: IDEMPOTENCY_KEY_BODY_MISMATCH,
    error:
      'This send reuses the key of an earlier one that the server already has, but the items ' +
      'differ. Nothing new was created. What the server has is shown; send the edited basket ' +
      'with a NEW key if it is still wanted.',
    order_id: stored.id,
    order_number: stored.order_number,
    tab_id: stored.tab_id,
    items: persistedItemsSummary(stored.items),
  }
}
