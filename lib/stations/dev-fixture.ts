/**
 * feat/station-screens-v1 — seeded fixture data.
 *
 * Stands in for order_lines / order_line_events until the service session relays that schema
 * (see types.ts's docblock). Used by __tests__/station-screens-render.test.tsx to prove the two
 * screens render correctly against real-shaped data, and safe to import from a page for local
 * visual checking before the real data port lands.
 *
 * Deliberately exercises every branch the brief calls out: all three escalation bands, a
 * route_to = 'unrouted' line on both screens, and a route_to = 'both' line bumped independently.
 */
import type { BarRound, KitchenLine } from '@/lib/stations/types'

const minutesAgo = (n: number, from: number) => new Date(from - n * 60_000).toISOString()

export function buildKitchenFixture(now: number = Date.now()): KitchenLine[] {
  return [
    // READY TO RUN, white (just bumped).
    {
      id: 'kl-1',
      tableNumber: '4',
      waiterName: 'Ana',
      itemName: 'Ribeye, medium',
      quantity: 1,
      station: 'grill',
      routeTo: 'kitchen',
      createdAt: minutesAgo(9, now),
      cookedAt: minutesAgo(2, now),
      readyToRunAt: minutesAgo(1, now),
    },
    // READY TO RUN, amber.
    {
      id: 'kl-2',
      tableNumber: '7',
      waiterName: 'Ben',
      itemName: 'Caesar salad',
      quantity: 2,
      station: 'salads',
      routeTo: 'kitchen',
      createdAt: minutesAgo(10, now),
      cookedAt: minutesAgo(5, now),
      readyToRunAt: minutesAgo(4, now),
    },
    // READY TO RUN, red — the one that should read loudest.
    {
      id: 'kl-3',
      tableNumber: '2',
      waiterName: 'Ana',
      itemName: 'Fish and chips',
      quantity: 1,
      station: 'fry',
      routeTo: 'both',
      createdAt: minutesAgo(15, now),
      cookedAt: minutesAgo(8, now),
      readyToRunAt: minutesAgo(7, now),
    },
    // OUTSTANDING, not yet cooked, table 4 alongside the ready-to-run ribeye.
    {
      id: 'kl-4',
      tableNumber: '4',
      waiterName: 'Ana',
      itemName: 'Truffle fries',
      quantity: 1,
      station: 'fry',
      routeTo: 'kitchen',
      createdAt: minutesAgo(3, now),
      cookedAt: null,
      readyToRunAt: null,
    },
    // OUTSTANDING, cooked and awaiting the pass — has the "Ready to run" button.
    {
      id: 'kl-5',
      tableNumber: '9',
      waiterName: 'Carla',
      itemName: 'Grilled chicken',
      quantity: 3,
      station: 'grill',
      routeTo: 'kitchen',
      createdAt: minutesAgo(6, now),
      cookedAt: minutesAgo(1, now),
      readyToRunAt: null,
    },
    // Unrouted — must never merge into table 9's outstanding group.
    {
      id: 'kl-6',
      tableNumber: '9',
      waiterName: 'Carla',
      itemName: 'Side of mash',
      quantity: 1,
      station: 'unknown',
      routeTo: 'unrouted',
      createdAt: minutesAgo(4, now),
      cookedAt: null,
      readyToRunAt: null,
    },
  ]
}

export function buildBarFixture(now: number = Date.now()): BarRound[] {
  return [
    // IN, oldest — FIFO puts this first.
    {
      id: 'br-1',
      tableNumber: '2',
      waiterName: 'Ana',
      items: [{ itemName: 'IPA', quantity: 2 }],
      // Same physical order as kl-3 (fish and chips) — bumped independently on this screen.
      routeTo: 'both',
      createdAt: minutesAgo(15, now),
      outAt: null,
    },
    // IN, newer.
    {
      id: 'br-2',
      tableNumber: '11',
      waiterName: 'Ben',
      items: [
        { itemName: 'Gin and tonic', quantity: 2 },
        { itemName: 'Sparkling water', quantity: 1 },
      ],
      routeTo: 'bar',
      createdAt: minutesAgo(2, now),
      outAt: null,
    },
    // OUT already — shows in the log column.
    {
      id: 'br-3',
      tableNumber: '5',
      waiterName: 'Carla',
      items: [{ itemName: 'House red, glass', quantity: 4 }],
      routeTo: 'bar',
      createdAt: minutesAgo(20, now),
      outAt: minutesAgo(12, now),
    },
    // Unrouted.
    {
      id: 'br-4',
      tableNumber: '9',
      waiterName: 'Carla',
      items: [{ itemName: 'Milkshake', quantity: 1 }],
      routeTo: 'unrouted',
      createdAt: minutesAgo(5, now),
      outAt: null,
    },
  ]
}
