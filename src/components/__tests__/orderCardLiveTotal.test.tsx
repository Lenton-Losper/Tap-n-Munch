/**
 * THE ORDER LIST CARD SHOWS WHAT AN ORDER IS WORTH NOW, NOT orders.total (Sprint 2026-09-29,
 * F-TERMPAY task 8).
 *
 * Rows are fed through mapRowToOrder exactly as GET /api/terminal/orders sends them, so the parse of
 * the server's `financials` block is under test too, not a hand-built Order.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';

import OrderCard from '../OrderCard';
import {mapRowToOrder} from '../../lib/orderMapper';

const baseRow = {
  id: 'order-160',
  restaurant_id: 'r-1',
  table_number: 1,
  order_number: 160,
  status: 'pending',
  placed_at: '2026-09-28T18:00:00.000Z',
  channel: 'table',
  items: [{id: 'i1', name: 'Modena Pasta', quantity: 1, price: 240}],
};

function money(original: number, voided: number, paid = 0) {
  const live = original - voided;
  return {
    original_cents: original,
    voided_cents: voided,
    live_cents: live,
    paid_cents: paid,
    outstanding_cents: Math.max(0, live - paid),
    overpaid_cents: Math.max(0, paid - live),
  };
}

async function render(row: Record<string, unknown>) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<OrderCard order={mapRowToOrder(row)} onPress={() => {}} />);
  });
  const byId = (id: string) => {
    const hits = tree.root.findAll(n => n.props?.testID === id && typeof n.type !== 'string');
    return hits.length ? String([hits[0].props.children].flat().join('')) : null;
  };
  return {byId};
}

describe('OrderCard money', () => {
  it('an AMENDED order shows its live value, with the original beside it', async () => {
    // Riviera #160: N$1,945 stored, N$1,480 voided, N$465 live.
    const {byId} = await render({...baseRow, total: 1945, financials: money(194500, 148000)});
    expect(byId('order-card-amount')).toBe('NAD465.00');
    expect(byId('order-card-after-voids')).toBe('NAD1945.00 original · NAD465.00 after voids');
    expect(byId('order-card-owed')).toBeNull();
  });

  it('a part-paid order also says what is still owed', async () => {
    const {byId} = await render({...baseRow, total: 37, financials: money(3700, 0, 1700)});
    expect(byId('order-card-amount')).toBe('NAD37.00');
    expect(byId('order-card-owed')).toBe('NAD20.00 still owed');
    expect(byId('order-card-after-voids')).toBeNull();
  });

  it('a fully voided order shows N$0.00, never its stored total', async () => {
    const {byId} = await render({...baseRow, total: 240, financials: money(24000, 24000)});
    expect(byId('order-card-amount')).toBe('NAD0.00');
    expect(byId('order-card-after-voids')).toBe('NAD240.00 original · NAD0.00 after voids');
  });

  it('an unamended order shows its total and no extra lines', async () => {
    const {byId} = await render({...baseRow, total: 240, financials: money(24000, 0)});
    expect(byId('order-card-amount')).toBe('NAD240.00');
    expect(byId('order-card-after-voids')).toBeNull();
    expect(byId('order-card-owed')).toBeNull();
  });

  it('NO figures from the server: the stored total is labelled as ordered, not shown bare', async () => {
    const {byId} = await render({...baseRow, total: 1945});
    expect(byId('order-card-amount')).toBe('Ordered NAD1945.00');
  });

  it('an UNREADABLE block (a float) is treated as absent, not trusted in part', async () => {
    const bad = {...money(194500, 148000), live_cents: 46500.5};
    const {byId} = await render({...baseRow, total: 1945, financials: bad});
    expect(byId('order-card-amount')).toBe('Ordered NAD1945.00');
  });
});
