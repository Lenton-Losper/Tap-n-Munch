/**
 * lib/stations/dev-fixture.ts — seeded fixture data for __tests__/station-screens-render.test.tsx
 * and for local visual checking of the two screens without a live GET /api/station/lines call.
 *
 * REBUILT 2026-08-28 against the real KitchenLine / BarRound shapes (lib/stations/types.ts) —
 * placedAt (order age) drives escalation now, not a per-line cooked/ready timestamp; there is no
 * 'ready' state to exercise here at all, because a line in that state could never reach either
 * screen (see types.ts's docblock).
 *
 * Deliberately exercises every branch the brief calls out: all three escalation bands on the
 * cooked-and-waiting zone, a route_to = 'unrouted' line on both screens, and a route_to = 'both'
 * line/round independent of its counterpart on the other screen.
 */
import type { BarRound, KitchenLine } from '@/lib/stations/types'

const minutesAgo = (n: number, from: number) => new Date(from - n * 60_000).toISOString()

export function buildKitchenFixture(now: number = Date.now()): KitchenLine[] {
  return [
    // COOKED, white (just plated) — order placed 1 min ago.
    {
      id: 'kl-1',
      orderId: 'o-1',
      tableNumber: '4',
      orderNumber: 101,
      itemName: 'Ribeye, medium',
      quantity: 1,
      lineNote: 'medium',
      routeTo: 'kitchen',
      state: 'cooked',
      placedAt: minutesAgo(1, now),
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // COOKED, amber — order placed 4 min ago.
    {
      id: 'kl-2',
      orderId: 'o-2',
      tableNumber: '7',
      orderNumber: 102,
      itemName: 'Caesar salad',
      quantity: 2,
      lineNote: null,
      routeTo: 'kitchen',
      state: 'cooked',
      placedAt: minutesAgo(4, now),
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // COOKED, red — the one that should read loudest. Also shared with bar ('both').
    {
      id: 'kl-3',
      orderId: 'o-3',
      tableNumber: '2',
      orderNumber: 103,
      itemName: 'Fish and chips',
      quantity: 1,
      lineNote: null,
      routeTo: 'both',
      state: 'cooked',
      placedAt: minutesAgo(7, now),
      unrouted: false,
      sharedWithOtherStation: true,
    },
    // OUTSTANDING, not yet cooked, table 4 alongside the cooked ribeye above.
    {
      id: 'kl-4',
      orderId: 'o-1',
      tableNumber: '4',
      orderNumber: 101,
      itemName: 'Truffle fries',
      quantity: 1,
      lineNote: null,
      routeTo: 'kitchen',
      state: 'outstanding',
      placedAt: minutesAgo(1, now),
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // OUTSTANDING, a different table.
    {
      id: 'kl-5',
      orderId: 'o-4',
      tableNumber: '9',
      orderNumber: 104,
      itemName: 'Grilled chicken',
      quantity: 3,
      lineNote: null,
      routeTo: 'kitchen',
      state: 'outstanding',
      placedAt: minutesAgo(6, now),
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // Unrouted — must never merge into table 9's outstanding group.
    {
      id: 'kl-6',
      orderId: 'o-4',
      tableNumber: '9',
      orderNumber: 104,
      itemName: 'Side of mash',
      quantity: 1,
      lineNote: null,
      routeTo: 'unrouted',
      state: 'outstanding',
      placedAt: minutesAgo(4, now),
      unrouted: true,
      sharedWithOtherStation: true,
    },
  ]
}

export function buildBarFixture(now: number = Date.now()): BarRound[] {
  return [
    // IN, oldest — FIFO puts this first. Same physical order as kl-3 (fish and chips) — an
    // independent round on this screen even though the kitchen's half of that order is cooked.
    {
      id: 'o-3',
      tableNumber: '2',
      orderNumber: 103,
      items: [{ itemName: 'IPA', quantity: 2, lineNote: null }],
      placedAt: minutesAgo(15, now),
      unrouted: false,
    },
    // IN, newer.
    {
      id: 'o-5',
      tableNumber: '11',
      orderNumber: 105,
      items: [
        { itemName: 'Gin and tonic', quantity: 2, lineNote: null },
        { itemName: 'Sparkling water', quantity: 1, lineNote: null },
      ],
      placedAt: minutesAgo(2, now),
      unrouted: false,
    },
    // Unrouted.
    {
      id: 'o-6',
      tableNumber: '9',
      orderNumber: 106,
      items: [{ itemName: 'Milkshake', quantity: 1, lineNote: null }],
      placedAt: minutesAgo(5, now),
      unrouted: true,
    },
  ]
}
