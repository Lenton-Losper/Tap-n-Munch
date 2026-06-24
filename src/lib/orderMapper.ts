import {Order, OrderItem, OrderStatus} from '../types';
import {getItemUnitPrice} from './currency';

function mapItem(raw: Record<string, unknown>, index: number): OrderItem {
  return {
    id: String(raw.id ?? `${raw.name ?? 'item'}-${index}`),
    name: String(raw.name ?? 'Item'),
    quantity: Number(raw.quantity ?? 1),
    price: getItemUnitPrice(raw),
    variant: raw.variant ? String(raw.variant) : undefined,
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
    table_number: Number(row.table_number),
    order_number: Number(row.order_number),
    status: row.status as OrderStatus,
    items,
    total: Number(row.total),
    placed_at: String(row.placed_at ?? row.created_at ?? new Date().toISOString()),
    member_name: row.member_name ? String(row.member_name) : undefined,
  };
}

export function isActiveOrder(order: Order): boolean {
  return order.status !== 'completed' && order.status !== 'cancelled';
}
