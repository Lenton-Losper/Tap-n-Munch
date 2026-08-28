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
      itemName: 'Ribeye',
      quantity: 1,
      lineNote: 'medium',
      routeTo: 'kitchen',
      state: 'cooked',
      placedAt: minutesAgo(1, now),
      cookedAt: minutesAgo(1, now),
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
      cookedAt: minutesAgo(4, now),
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
      cookedAt: minutesAgo(7, now),
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
      cookedAt: null,
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
      cookedAt: null,
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
      cookedAt: null,
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
      items: [{ id: 'bl-1', itemName: 'IPA', quantity: 2, lineNote: null }],
      placedAt: minutesAgo(15, now),
      unrouted: false,
    },
    // IN, newer.
    {
      id: 'o-5',
      tableNumber: '11',
      orderNumber: 105,
      items: [
        { id: 'bl-2', itemName: 'Gin and tonic', quantity: 2, lineNote: null },
        { id: 'bl-3', itemName: 'Sparkling water', quantity: 1, lineNote: null },
      ],
      placedAt: minutesAgo(2, now),
      unrouted: false,
    },
    // Unrouted.
    {
      id: 'o-6',
      tableNumber: '9',
      orderNumber: 106,
      items: [{ id: 'bl-4', itemName: 'Milkshake', quantity: 1, lineNote: null }],
      placedAt: minutesAgo(5, now),
      unrouted: true,
    },
  ]
}

/**
 * ============================================================================================
 * A FULL BOARD — TWENTY TABLES. THE LAYOUT QUESTION ONLY EXISTS AT THIS SIZE.
 * ============================================================================================
 *
 * The six-line fixture above is for the unit render test and it proves nothing about the wall: four
 * cards fit any layout. The defect the owner reported — two cards across a 1920x1080 screen, a busy
 * board scrolling, and a wall screen nobody touches therefore hiding half the service — is only
 * visible when the board is FULL.
 *
 * So this one is deliberately hostile to the layout, and every awkward case in it is one that has
 * actually reached a real board:
 *
 *   - TWENTY table cards, eight on the pass and twelve outstanding.
 *   - Line counts from one to four per table, so the grid cannot assume a uniform card height.
 *   - Ages spanning every band on both clocks: seconds, minutes, the amber and red bands, past
 *     STALE_MINUTES, and 12877 minutes — the exact number the owner photographed, which must read
 *     "8d" and must be the QUIETEST card on the board, not the loudest.
 *   - A table with NO table number, which is a real order shape (GET /api/station/lines normalises
 *     a zero or absent table to null) and must read "No table", never "Table 0" and never a dash.
 *   - An unrouted line, which must never merge into an ordinary table card.
 *   - A line shared with the bar ('both'), independent of the bar's half.
 *
 * Rendered by app/dev-kitchen-preview and measured at 1920x1080 by
 * tests/e2e/station-board-wall-fit.spec.ts.
 */
type KitchenSeed = {
  table: string
  /** Minutes ago the ORDER was placed. */
  placed: number
  /** Minutes ago each line was tapped Cooked. Present => the line is on the pass. */
  cooked?: number
  items: Array<[name: string, quantity: number, note?: string]>
  routeTo?: KitchenLine['routeTo']
}

const KITCHEN_WALL_SEED: KitchenSeed[] = [
  // ---- ON THE PASS (cooked, waiting to be run) — eight cards --------------------------------
  { table: '2', placed: 9, cooked: 1, items: [['Ribeye', 1, 'medium rare']] },
  { table: '3', placed: 14, cooked: 4, items: [['Caesar salad', 2], ['Garlic bread', 1]] },
  { table: '5', placed: 21, cooked: 9, items: [['Fish and chips', 1]] },
  {
    table: '7',
    placed: 26,
    cooked: 7,
    items: [['Lamb shank', 1], ['Butter chicken', 2, 'extra rice'], ['Naan', 3]],
  },
  { table: '9', placed: 310, cooked: 300, items: [['Prawn linguine', 1]] },
  { table: '11', placed: 12900, cooked: 12877, items: [['Beef burger', 1], ['Onion rings', 1]] },
  { table: '14', placed: 6, cooked: 0, items: [['Margherita', 1]] },
  // No table number at all — the shape GET /api/station/lines normalises to null.
  { table: '', placed: 16, cooked: 6, items: [['Chicken schnitzel', 1], ['Side salad', 1]] },

  // ---- OUTSTANDING (the station still has these) — twelve cards -----------------------------
  { table: '1', placed: 3, items: [['Calamari', 1]] },
  { table: '4', placed: 12, items: [['Sirloin', 2, 'one well done'], ['Truffle fries', 1], ['Creamed spinach', 1]] },
  { table: '6', placed: 25, items: [['Pork belly', 1], ['Roast potatoes', 2]] },
  { table: '8', placed: 1, items: [['Soup of the day', 1]] },
  { table: '10', placed: 18, items: [['Kingklip', 2], ['Lemon butter', 1], ['Steamed veg', 2]] },
  { table: '12', placed: 45, items: [['Oxtail', 1, 'no carrots'], ['Samp', 1]] },
  { table: '15', placed: 7, items: [['Chicken wrap', 1]] },
  {
    table: '16',
    placed: 21,
    items: [['T-bone', 2], ['Peri peri chicken', 1], ['Halloumi skewer', 1], ['Chips', 3]],
  },
  { table: '17', placed: 11, items: [['Bobotie', 1], ['Yellow rice', 1]] },
  { table: '18', placed: 2, items: [['Boerewors roll', 2]] },
  // Shared with the bar: the bar has its own half of this order, independently.
  { table: '19', placed: 9, items: [['Mussels', 1], ['Crusty bread', 1]], routeTo: 'both' },
  { table: '21', placed: 300, items: [['Vegetable curry', 1], ['Roti', 2]] },
]

export function buildKitchenWallFixture(now: number = Date.now()): KitchenLine[] {
  const lines: KitchenLine[] = []
  let n = 0

  for (const [index, seed] of KITCHEN_WALL_SEED.entries()) {
    for (const [name, quantity, note] of seed.items) {
      n += 1
      lines.push({
        id: `kw-${n}`,
        orderId: `ow-${index + 1}`,
        tableNumber: seed.table,
        orderNumber: 200 + index,
        itemName: name,
        quantity,
        lineNote: note ?? null,
        routeTo: seed.routeTo ?? 'kitchen',
        state: seed.cooked === undefined ? 'outstanding' : 'cooked',
        placedAt: minutesAgo(seed.placed, now),
        cookedAt: seed.cooked === undefined ? null : minutesAgo(seed.cooked, now),
        unrouted: false,
        sharedWithOtherStation: (seed.routeTo ?? 'kitchen') !== 'kitchen',
      })
    }
  }

  // Unrouted, and it must never be absorbed into table 6's card.
  lines.push({
    id: 'kw-unrouted-1',
    orderId: 'ow-11',
    tableNumber: '6',
    orderNumber: 202,
    itemName: 'Chef special (no category)',
    quantity: 1,
    lineNote: null,
    routeTo: 'unrouted',
    state: 'outstanding',
    placedAt: minutesAgo(25, now),
    cookedAt: null,
    unrouted: true,
    sharedWithOtherStation: true,
  })

  return lines
}

/**
 * The bar at the same volume — twenty rounds.
 *
 * Same shapes the kitchen fixture exercises (an absent table, an unrouted round, item counts from
 * one to four, ages from seconds to 12877 minutes) so the two boards can be read side by side and
 * any difference between them is a design decision rather than a difference in the data.
 *
 * NOTE what this fixture CANNOT show, and that is half the point of it existing: the bar has no age
 * escalation by standing ruling, so all twenty of these cards are the same colour no matter how the
 * ages are spread. See components/stations/bar-screen.tsx.
 */
const BAR_WALL_SEED: Array<{ table: string; placed: number; items: Array<[string, number, string?]> }> = [
  { table: '2', placed: 12877, items: [['House red', 2]] },
  { table: '3', placed: 300, items: [['Craft lager', 4]] },
  { table: '5', placed: 41, items: [['Espresso martini', 2], ['Old fashioned', 1]] },
  { table: '7', placed: 26, items: [['Savanna', 3], ['Coke', 2, 'no ice'], ['Still water', 1]] },
  { table: '9', placed: 22, items: [['Chardonnay', 2]] },
  { table: '11', placed: 19, items: [['Gin and tonic', 2], ['Sparkling water', 1]] },
  { table: '', placed: 17, items: [['Pilsner', 1], ['Lime soda', 1]] },
  { table: '1', placed: 15, items: [['Cappuccino', 2]] },
  { table: '4', placed: 13, items: [['Pinotage', 1], ['Merlot', 2], ['Soda water', 1], ['Rooibos', 1]] },
  { table: '6', placed: 11, items: [['Draught', 4]] },
  { table: '8', placed: 9, items: [['Mojito', 2], ['Virgin mojito', 1]] },
  { table: '10', placed: 8, items: [['Iced tea', 3]] },
  { table: '12', placed: 7, items: [['Whisky sour', 1], ['Neat bourbon', 1, 'double']] },
  { table: '15', placed: 6, items: [['Orange juice', 2]] },
  { table: '16', placed: 4, items: [['Aperol spritz', 3], ['Prosecco', 1]] },
  { table: '17', placed: 3, items: [['Ginger beer', 2]] },
  { table: '18', placed: 2, items: [['Americano', 1], ['Flat white', 1], ['Hot chocolate', 1]] },
  { table: '19', placed: 1, items: [['Sauvignon blanc', 2]] },
  { table: '21', placed: 0, items: [['Tap water', 4]] },
]

export function buildBarWallFixture(now: number = Date.now()): BarRound[] {
  const rounds: BarRound[] = BAR_WALL_SEED.map((seed, index) => ({
    id: `bw-${index + 1}`,
    tableNumber: seed.table,
    orderNumber: 300 + index,
    items: seed.items.map(([itemName, quantity, lineNote], itemIndex) => ({
      id: `bwl-${index + 1}-${itemIndex + 1}`,
      itemName,
      quantity,
      lineNote: lineNote ?? null,
    })),
    placedAt: minutesAgo(seed.placed, now),
    unrouted: false,
  }))

  // The twentieth card: unrouted, and therefore carrying no controls at all.
  rounds.push({
    id: 'bw-unrouted',
    tableNumber: '14',
    orderNumber: 320,
    items: [{ id: 'bwl-unrouted-1', itemName: 'Milkshake (no category)', quantity: 1, lineNote: null }],
    placedAt: minutesAgo(5, now),
    unrouted: true,
  })

  return rounds
}
