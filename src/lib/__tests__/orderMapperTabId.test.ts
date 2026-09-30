/**
 * mapRowToOrder carries tab_id (2026-09-30).
 *
 * It never did: every Order the terminal read had no tab, so resolveOrderMoney took its no-tab
 * branch and the Payment / Order Detail screens showed the stored original for a tab order, voided
 * lines included. The screen-level regression is paymentScreenSingleOrderFetch.test.tsx; this pins
 * the mapper's own contract, including that "no tab" keeps exactly the shape the server sent.
 */
import {mapRowToOrder} from '../orderMapper';

const BASE = {
  id: '11111111-1111-4111-8111-111111111111',
  restaurant_id: 'r1',
  order_number: 59,
  status: 'pending',
  total: 30,
  items: [],
  placed_at: '2026-09-30T07:40:44.238Z',
};

describe('mapRowToOrder: tab_id', () => {
  it('copies the tab id the server sent', () => {
    expect(mapRowToOrder({...BASE, tab_id: 'tab-9'}).tab_id).toBe('tab-9');
  });

  it('a walk-up order (tab_id null) stays null', () => {
    expect(mapRowToOrder({...BASE, tab_id: null}).tab_id).toBeNull();
  });

  it('a row that does not carry the field stays undefined', () => {
    const order = mapRowToOrder({...BASE});
    expect(order.tab_id).toBeUndefined();
  });

  it('changes nothing else: the same row maps identically apart from tab_id', () => {
    const withTab: Record<string, unknown> = {...mapRowToOrder({...BASE, tab_id: 'tab-9'})};
    const withoutTab: Record<string, unknown> = {...mapRowToOrder({...BASE})};
    delete withTab.tab_id;
    delete withoutTab.tab_id;
    expect(withTab).toEqual(withoutTab);
  });
});
