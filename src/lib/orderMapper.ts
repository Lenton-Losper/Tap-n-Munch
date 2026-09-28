import {Order, OrderItem, OrderStatus} from '../types';
import {getItemUnitPrice} from './currency';
import {variantSummary} from './variantPricing';

/**
 * The variant to show beside an existing order line.
 *
 * `variant` / `variant_name` were read here for years and nothing ever wrote them. What the
 * server actually persists (C6) is `selectedVariants` -- and it ALSO writes the display name
 * ("Americano - Large") into `name`. So the selection is shown only when the name does not
 * already carry it, or the row would read "Americano - Large (Large)".
 */
function lineVariant(raw: Record<string, unknown>, name: string): string | undefined {
  if (raw.variant) {
    return String(raw.variant);
  }
  if (raw.variant_name) {
    return String(raw.variant_name);
  }
  const summary = variantSummary(raw.selectedVariants ?? raw.selected_variants);
  if (!summary || name.endsWith(` - ${summary}`)) {
    return undefined;
  }
  return summary;
}

function mapItem(raw: Record<string, unknown>, index: number): OrderItem {
  const name = String(
    raw.name ?? raw.item_name ?? raw.menu_item_name ?? 'Item',
  );
  return {
    id: String(raw.id ?? `${raw.name ?? 'item'}-${index}`),
    name,
    quantity: Number(raw.quantity ?? raw.qty ?? 1),
    price: getItemUnitPrice(raw),
    variant: lineVariant(raw, name),
  };
}

export function mapRowToOrder(row: Record<string, unknown>): Order {
  const rawItems = row.items;
  let items: OrderItem[] = [];

  if (Array.isArray(rawItems)) {
    items = rawItems.map((item, index) =>
      mapItem(item as Record<string, unknown>, index),
    );
  } else if (typeof rawItems === 'string') {
    try {
      const parsed = JSON.parse(rawItems) as Record<string, unknown>[];
      items = parsed.map((item, index) => mapItem(item, index));
    } catch {
      items = [];
    }
  }

  return {
    id: String(row.id ?? row.order_id ?? ''),
    restaurant_id: String(row.restaurant_id),
    table_id: row.table_id ? String(row.table_id) : undefined,
    table_number: Number(row.table_number),
    order_number: Number(row.order_number),
    status: row.status as OrderStatus,
    items,
    total: Number(row.total),
    placed_at: String(row.placed_at ?? row.created_at ?? new Date().toISOString()),
    member_name: row.member_name ? String(row.member_name) : undefined,
    channel: String(row.channel ?? 'table'),
    customer_name: row.customer_name ? String(row.customer_name) : undefined,
    kiosk_order_number: row.kiosk_order_number
      ? Number(row.kiosk_order_number)
      : undefined,
    payment_status: row.payment_status ? String(row.payment_status) : undefined,
    payment_status_derived:
      (row.payment_status_derived as Order['payment_status_derived']) ?? null,
    refunded_amount:
      row.refunded_amount != null ? Number(row.refunded_amount) : undefined,
  };
}

export function isRefunded(order: Order): boolean {
  return order.payment_status_derived === 'refunded';
}
