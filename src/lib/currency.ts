import {OrderItem} from '../types';

function firstFiniteNumber(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') {
      continue;
    }
    const num = Number(candidate);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function nestedItemRecord(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const key of ['menu_item', 'menuItem', 'product', 'item']) {
    const value = item[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Resolves unit price from common terminal / kiosk / web order-item shapes.
 * Falls back to line total ÷ quantity when unit fields are missing or zero.
 */
export function getItemUnitPrice(
  item: OrderItem | Record<string, unknown>,
): number {
  const raw = item as Record<string, unknown>;
  const nested = nestedItemRecord(raw);

  const unit = firstFiniteNumber(
    raw.price,
    raw.base_price,
    raw.basePrice,
    raw.unitPrice,
    raw.unit_price,
    raw.item_price,
    raw.itemPrice,
    nested?.price,
    nested?.base_price,
    nested?.basePrice,
    nested?.unit_price,
    nested?.unitPrice,
  );

  if (unit != null && unit > 0) {
    return unit;
  }

  const quantity = firstFiniteNumber(raw.quantity, raw.qty) ?? 1;
  const safeQty = quantity > 0 ? quantity : 1;
  const lineTotal = firstFiniteNumber(
    raw.line_total,
    raw.lineTotal,
    raw.subtotal,
    raw.total_price,
    raw.totalPrice,
    raw.amount,
    raw.line_amount,
    raw.lineAmount,
  );

  if (lineTotal != null && lineTotal > 0) {
    return lineTotal / safeQty;
  }

  return unit ?? 0;
}

/** Line amount for display (unit × qty), using mapped or raw item fields. */
export function getItemLineTotal(
  item: OrderItem | Record<string, unknown>,
): number {
  const raw = item as Record<string, unknown>;
  const quantity = firstFiniteNumber(raw.quantity, raw.qty) ?? 1;
  const safeQty = quantity > 0 ? quantity : 1;
  const lineTotal = firstFiniteNumber(
    raw.line_total,
    raw.lineTotal,
    raw.subtotal,
    raw.total_price,
    raw.totalPrice,
    raw.amount,
    raw.line_amount,
    raw.lineAmount,
  );
  if (lineTotal != null && lineTotal > 0) {
    return lineTotal;
  }
  return getItemUnitPrice(raw) * safeQty;
}

export function formatCurrency(amount: number): string {
  const num = Number(amount);
  const safe = Number.isFinite(num) ? num : 0;
  return `NAD${safe.toFixed(2)}`;
}
