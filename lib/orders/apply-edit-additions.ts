/**
 * Adding items to an order that has not been prepared yet.
 *
 * RULED by the human 2026-08-16, overruling redesign spec section 22:
 *
 *   > "Editing an order means changing it: add items, remove items, change quantities, swap one
 *   >  item for another, edit notes. The full set. … editing closes the moment the kitchen starts
 *   >  preparing, so an editable order is one the kitchen does not yet have. Adding to it mutates
 *   >  nothing that is being cooked. Expand the edit API accordingly."
 *
 * This is the QR audit's **Model A** — the addition mutates the existing order — and the audit
 * recommended Model B (a second internal order) instead. The human chose Model A knowingly, and
 * the audit's own objection is the thing this module exists to answer, so it is worth stating
 * plainly rather than leaving in another document:
 *
 *   > "Four guards protect the creation of a sale — the stock sufficiency check, the per-line
 *   >  quantity cap, the payment-method allowlist, and pricing against the live menu — and all
 *   >  four are attached to POST /api/orders and none of them is in the edit route. … The moment
 *   >  it can add, [the strict-reduction] argument is gone and the route needs to be re-reasoned
 *   >  from scratch."
 *
 * That is correct, and it is why this module ports three of the four rather than reasoning around
 * them. Verified at 85a945c, not inherited from the audit:
 *
 *   checkStockSufficiency    only app/api/orders/route.ts:187 and terminal/orders/route.ts:100
 *   validateOrderQuantities  only app/api/orders/route.ts:58
 *   calculateOrderPricing    not reachable from the edit route at all
 *
 * THE FOURTH GUARD, and why it is deliberately NOT ported. The payment-method allowlist does not
 * apply: an addition to a tab order chooses no payment method — the tab is settled as a whole,
 * later, by staff on the terminal — so there is nothing to check it against. Adding a check with
 * no input would be ceremony. Recorded rather than silently omitted.
 *
 * MIXED-VINTAGE PRICING — a new ruling, taken here, flagged in the handover. Surviving lines keep
 * the price and the tax rate stored at placement (`repriceKeptLines` reuses each line's own
 * `taxRatePercentage` / `taxInclusive`), while an added line is priced at today's menu and
 * today's tax rate. So one order can carry two vintages.
 *
 * The alternative — repricing the survivors too — was rejected for the reason already written
 * into `reprice-priced-lines.ts`: it would move the price of items the customer is KEEPING, and
 * it would throw `UnmatchedMenuItemError` if a survivor had since gone out of stock, refusing a
 * removal for a reason unrelated to the removal. Mixed vintage is also what a real bill does: you
 * are charged what a thing cost when you ordered it. The cost is that one order's lines can
 * disagree about tax basis, which the four receipt renderers already disagree about (#250/#251),
 * so this does not make that worse — it does add a second way to reach it.
 *
 * A FAILED STOCK READ IS NOT A REFUSAL, matching POST /api/orders exactly: a balance query that
 * errors is logged and the addition proceeds. Refusing every edit because a read failed is worse
 * than the occasional oversell, and diverging from the creation path here would mean the same
 * customer action succeeds or fails depending on which route they reached it through.
 */
import { checkStockSufficiency } from '@/lib/orders/check-stock-sufficiency'
import {
  validateOrderQuantities,
  validateResultingQuantities,
} from '@/lib/orders/quantity-limits'
import { QR_REDESIGN_PENDING_COPY } from '@/lib/customer-copy/qr-redesign-copy'
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'
import { roundToCents } from '@/lib/payments/payment-integrity'

/** Same client item shape `POST /api/orders` accepts, so the pricer needs no adapter. */
export type EditAdditionInput = Record<string, unknown>

export type EditAdditionRefusal =
  | { kind: 'quantity'; message: string }
  | { kind: 'out_of_stock'; message: string; unavailable: Array<{ item: string; ingredient: string }> }
  | { kind: 'pricing'; message: string; code?: string }

export type EditAdditionResult =
  | { ok: true; items: unknown[]; subtotal: number; tax: number; total: number }
  | { ok: false; refusal: EditAdditionRefusal }

type SupabaseLike = Parameters<typeof calculateOrderPricing>[0]

export type ApplyEditAdditionsInput = {
  supabase: SupabaseLike
  restaurantUuid: string
  /** The kept lines, already repriced by `repriceKeptLines`. Untouched here. */
  kept: { items: unknown[]; subtotal: number; tax: number; total: number }
  /** Raw client items to add. Empty or absent means this is a pure reduction. */
  additions: EditAdditionInput[]
}

/**
 * @returns the merged order, or the refusal to send back. Never throws for a customer-caused
 *          problem — the caller maps `refusal.kind` to a status code, so a new refusal reason
 *          cannot accidentally become a 500.
 */
export async function applyEditAdditions(
  input: ApplyEditAdditionsInput,
): Promise<EditAdditionResult> {
  const additions = Array.isArray(input.additions) ? input.additions : []
  if (additions.length === 0) {
    return { ok: true, ...input.kept }
  }

  /**
   * GUARD 1 — the per-line quantity cap. `extractQuantity` coerces anything unusable to 1 and
   * accepts any positive finite number, so without this an addition of 9999 or 2.5 of something
   * is priced and charged. This is the check `POST /api/orders` applies to `channel === 'table'`,
   * and a customer edit is the same channel by definition.
   */
  const quantityCheck = validateOrderQuantities(additions)
  if (!quantityCheck.ok) {
    return { ok: false, refusal: { kind: 'quantity', message: quantityCheck.reason } }
  }

  /**
   * GUARD 1b — the RESULTING quantity (#307). Ruled 2026-08-17.
   *
   * GUARD 1 caps each proposed line on its own, which is why an order already holding 12 accepted
   * another 12: both calls were individually legal and nothing looked at the sum. Measured on
   * staging, 2 + 20 = 22 against a ceiling of 20.
   *
   * This caps what the order would HOLD. It groups by `capIdentity`, which excludes price, so two
   * price lots of the same burger share one ceiling instead of each getting a fresh one -- the
   * ruling's point 5.
   *
   * GUARD 1 is NOT replaced by this. It stays as the hard per-line server ceiling for a single
   * malformed line; a soft high-quantity confirmation, if one is ever added, sits below both.
   */
  const keptLines = Array.isArray(input.kept?.items) ? (input.kept.items as EditAdditionInput[]) : []
  const resulting = validateResultingQuantities(keptLines, additions)
  if (!resulting.ok) {
    const { itemName, maximum, remaining } = resulting.refusal
    return {
      ok: false,
      refusal: {
        kind: 'quantity',
        message: QR_REDESIGN_PENDING_COPY.quantityCapReached
          .replace('{item}', itemName || 'this item')
          .replace('{maximum}', String(maximum))
          .replace('{remaining}', String(remaining)),
      },
    }
  }

  /**
   * GUARD 2 — stock. This is the oversell path (#146/#147), whose race was MEASURED not to be
   * fixed by locking, so this is a placement-time refusal and nothing more. It is the same call
   * the creation route makes, with the same fail-open on a read error and the same reason.
   */
  try {
    const sufficiency = await checkStockSufficiency(input.supabase as never, input.restaurantUuid, additions)
    if (!sufficiency.ok) {
      return {
        ok: false,
        refusal: {
          kind: 'out_of_stock',
          message: sufficiency.reason,
          unavailable: sufficiency.unavailable.map((u) => ({
            item: u.itemName,
            ingredient: u.stockItemName,
          })),
        },
      }
    }
  } catch (err) {
    // Deliberately identical to POST /api/orders: a failure to READ stock must not take ordering
    // down. Diverging would make the same action succeed or fail by route.
    console.error('[EDIT] stock sufficiency check failed, allowing addition through:', err)
  }

  /**
   * GUARD 3 — pricing against the LIVE menu. The client's own prices are discarded here exactly
   * as they are on creation; nothing a customer sends decides money.
   */
  let priced
  try {
    priced = await calculateOrderPricing(input.supabase, input.restaurantUuid, additions)
  } catch (err) {
    const code = (err as { code?: string })?.code
    return {
      ok: false,
      refusal: {
        kind: 'pricing',
        message: err instanceof Error ? err.message : 'Could not price the added items',
        ...(code ? { code } : {}),
      },
    }
  }

  if (priced.warnings.length > 0) {
    console.warn('[EDIT] pricing warnings on added lines', priced.warnings)
  }

  /**
   * The merge. Sums are taken here, server-side, over two server-produced halves — the client
   * sends no total and none is trusted. `roundToCents` for the same reason every other money sum in
   * the product uses it: two rounded halves added raw reintroduce the sub-cent drift #180 exists
   * to remove.
   */
  return {
    ok: true,
    items: [...input.kept.items, ...priced.items],
    subtotal: roundToCents(input.kept.subtotal + priced.subtotal),
    tax: roundToCents(input.kept.tax + priced.tax),
    total: roundToCents(input.kept.total + priced.total),
  }
}
