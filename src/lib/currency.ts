import {OrderItem} from '../types';

export function getItemUnitPrice(
  item: OrderItem | Record<string, unknown>,
): number {
  const raw = item as Record<string, unknown>;
  const price =
    raw.price ?? raw.base_price ?? raw.unitPrice ?? raw.unit_price ?? 0;
  const num = Number(price);
  return Number.isFinite(num) ? num : 0;
}

export function formatCurrency(amount: number): string {
  const num = Number(amount);
  const safe = Number.isFinite(num) ? num : 0;
  return `NAD${safe.toFixed(2)}`;
}
