/**
 * lib/stations/dev-fixture.ts — seeded fixture data for __tests__/station-screens-render.test.tsx
 * and for local visual checking of the two screens without a live GET /api/station/lines call.
 *
 * REBUILT 20260829160000 for the pinned Ready zone: every fixture now includes 'ready' lines
 * (previously impossible — GET /api/station/lines excluded them before they could ever reach a
 * screen) and a two-clock shape (cookedAt AND readyAt) on every line/item. The bar's small fixture
 * also exercises a round split between zones — one drink ready, one still pending on the SAME
 * round — because "PER LINE, both boards" means that is a real, expected shape, not an edge case.
 *
 * Deliberately exercises every branch the brief calls out: all four escalation bands in BOTH
 * zones on BOTH boards, a route_to = 'unrouted' line/round on both screens, a route_to = 'both'
 * line independent of its counterpart on the other screen, and the bar's own neutral-vs-ageing
 * split between its two zones.
 */
import type { BarRound, KitchenLine } from '@/lib/stations/types'

const minutesAgo = (n: number, from: number) => new Date(from - n * 60_000).toISOString()

export function buildKitchenFixture(now: number = Date.now()): KitchenLine[] {
  return [
    // ACTIVE, cooked, white (just plated) — order placed 1 min ago.
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
      readyAt: null,
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // ACTIVE, cooked, amber — order placed 4 min ago.
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
      readyAt: null,
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // ACTIVE, cooked, red — the loudest thing in the active zone. Also shared with bar ('both').
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
      readyAt: null,
      unrouted: false,
      sharedWithOtherStation: true,
    },
    // ACTIVE, outstanding, table 4 alongside the cooked ribeye above.
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
      readyAt: null,
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // ACTIVE, outstanding, a different table.
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
      readyAt: null,
      unrouted: false,
      sharedWithOtherStation: false,
    },
    // Unrouted — must never merge into table 9's active card.
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
      readyAt: null,
      unrouted: true,
      sharedWithOtherStation: true,
    },
    // READY, PINNED — passed, waiting to be run. The zone that could not exist before this rebuild.
    {
      id: 'kl-7',
      orderId: 'o-5',
      tableNumber: '5',
      orderNumber: 105,
      itemName: 'Onion rings',
      quantity: 1,
      lineNote: null,
      routeTo: 'kitchen',
      state: 'ready',
      placedAt: minutesAgo(10, now),
      cookedAt: minutesAgo(4, now),
      readyAt: minutesAgo(2, now),
      unrouted: false,
      sharedWithOtherStation: false,
    },
  ]
}

export function buildBarFixture(now: number = Date.now()): BarRound[] {
  return [
    // ACTIVE, oldest — FIFO puts this first. Same physical order as kl-3 (fish and chips) — an
    // independent round on this screen even though the kitchen's half of that order is cooked.
    {
      id: 'o-3',
      tableNumber: '2',
      orderNumber: 103,
      items: [{ id: 'bl-1', itemName: 'IPA', quantity: 2, lineNote: null, state: 'outstanding', cookedAt: null, readyAt: null }],
      placedAt: minutesAgo(15, now),
      unrouted: false,
    },
    // ACTIVE + READY, SAME ROUND — the split the "PER LINE" ruling exists for: one drink poured
    // and waiting, one not. This round appears once with each state's own item(s).
    {
      id: 'o-5',
      tableNumber: '11',
      orderNumber: 105,
      items: [
        { id: 'bl-2', itemName: 'Gin and tonic', quantity: 2, lineNote: null, state: 'outstanding', cookedAt: null, readyAt: null },
        {
          id: 'bl-3',
          itemName: 'Sparkling water',
          quantity: 1,
          lineNote: null,
          state: 'ready',
          cookedAt: null,
          readyAt: minutesAgo(3, now),
        },
      ],
      placedAt: minutesAgo(2, now),
      unrouted: false,
    },
    // Unrouted.
    {
      id: 'o-6',
      tableNumber: '9',
      orderNumber: 106,
      items: [{ id: 'bl-4', itemName: 'Milkshake', quantity: 1, lineNote: null, state: 'outstanding', cookedAt: null, readyAt: null }],
      placedAt: minutesAgo(5, now),
      unrouted: true,
    },
  ]
}

/**
 * ============================================================================================
 * A FULL BOARD — TWENTY ROUNDS. THE LAYOUT QUESTION ONLY EXISTS AT THIS SIZE.
 * ============================================================================================
 *
 * The small fixture above is for the unit render test and proves nothing about the wall: a
 * handful of rounds fit any layout. This one is deliberately hostile to the layout, and every
 * awkward case in it is one that has actually reached a real board:
 *
 *   - TWENTY table groups: twelve outstanding, three cooked-and-waiting (all ACTIVE), five READY.
 *   - Line counts from one to four per table, so the flow cannot assume a uniform round height.
 *   - Ages spanning every band on all three clocks (ticket, pass, ready): seconds, minutes, the
 *     amber and red bands, past STALE_MINUTES, and 12877 minutes — the exact number the owner
 *     photographed, which must read "8d" and must be the QUIETEST round in its zone, not loudest.
 *   - A table with NO table number, in the Ready zone, which must read "No table", never "Table 0"
 *     and never a dash.
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
  /** Minutes ago each line was tapped Cooked. Present => at least cooked. */
  cooked?: number
  /** Minutes ago each line was tapped Ready to run. Present => in the pinned Ready zone. */
  ready?: number
  items: Array<[name: string, quantity: number, note?: string]>
  routeTo?: KitchenLine['routeTo']
}

const KITCHEN_WALL_SEED: KitchenSeed[] = [
  // ---- READY, PINNED (passed, waiting to be run) — five cards, all four escalation bands ------
  { table: '2', placed: 9, cooked: 1, ready: 1, items: [['Ribeye', 1, 'medium rare']] },
  { table: '5', placed: 21, cooked: 8, ready: 4, items: [['Fish and chips', 1]] },
  { table: '9', placed: 310, cooked: 295, ready: 9, items: [['Prawn linguine', 1]] },
  { table: '11', placed: 12900, cooked: 12880, ready: 12877, items: [['Beef burger', 1], ['Onion rings', 1]] },
  { table: '', placed: 16, cooked: 8, ready: 6, items: [['Chicken schnitzel', 1], ['Side salad', 1]] },

  // ---- ACTIVE, cooked-and-waiting (still active — pass has not passed it yet) — three cards ----
  { table: '3', placed: 14, cooked: 4, items: [['Caesar salad', 2], ['Garlic bread', 1]] },
  { table: '7', placed: 26, cooked: 7, items: [['Lamb shank', 1], ['Butter chicken', 2, 'extra rice'], ['Naan', 3]] },
  { table: '14', placed: 6, cooked: 0, items: [['Margherita', 1]] },

  // ---- ACTIVE, not yet started — twelve cards -----------------------------------------------
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
    const state: KitchenLine['state'] = seed.ready !== undefined ? 'ready' : seed.cooked !== undefined ? 'cooked' : 'outstanding'
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
        state,
        placedAt: minutesAgo(seed.placed, now),
        cookedAt: seed.cooked === undefined ? null : minutesAgo(seed.cooked, now),
        readyAt: seed.ready === undefined ? null : minutesAgo(seed.ready, now),
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
    readyAt: null,
    unrouted: true,
    sharedWithOtherStation: true,
  })

  return lines
}

/**
 * The bar at the same volume — twenty rounds, same split as the kitchen: five already poured and
 * waiting for collection, fifteen still to make. Same shapes the kitchen fixture exercises (an
 * absent table, an unrouted round, item counts from one to four, ages from seconds to 12877
 * minutes) so the two boards can be read side by side and any difference between them is a design
 * decision rather than a difference in the data.
 *
 * NOTE what the TO MAKE half of this fixture cannot show, and that is half the point of it
 * existing: that zone has no age escalation by standing ruling, so every TO MAKE card is the same
 * colour no matter how its age is spread. See components/stations/bar-screen.tsx.
 */
type BarSeed = {
  table: string
  placed: number
  /** Minutes ago poured. Present => this round's items are in the pinned Waiting-for-collection
   *  zone instead of TO MAKE. */
  ready?: number
  items: Array<[string, number, string?]>
}

const BAR_WALL_SEED: BarSeed[] = [
  // ---- WAITING FOR COLLECTION — five rounds, all four escalation bands -----------------------
  { table: '2', placed: 12900, ready: 1, items: [['House red', 2]] },
  { table: '3', placed: 20, ready: 4, items: [['Craft lager', 4]] },
  { table: '5', placed: 45, ready: 8, items: [['Espresso martini', 2], ['Old fashioned', 1]] },
  { table: '7', placed: 12900, ready: 12877, items: [['Savanna', 3], ['Coke', 2, 'no ice'], ['Still water', 1]] },
  { table: '9', placed: 24, ready: 6, items: [['Chardonnay', 2]] },

  // ---- TO MAKE — fifteen rounds, deliberately neutral no matter the age spread ----------------
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
      state: (seed.ready === undefined ? 'outstanding' : 'ready') as BarRound['items'][number]['state'],
      cookedAt: null,
      readyAt: seed.ready === undefined ? null : minutesAgo(seed.ready, now),
    })),
    placedAt: minutesAgo(seed.placed, now),
    unrouted: false,
  }))

  // The twenty-first card: unrouted, and therefore carrying no controls at all — not counted in
  // the twenty, same convention the kitchen fixture uses for its own unrouted extra.
  rounds.push({
    id: 'bw-unrouted',
    tableNumber: '14',
    orderNumber: 320,
    items: [
      {
        id: 'bwl-unrouted-1',
        itemName: 'Milkshake (no category)',
        quantity: 1,
        lineNote: null,
        state: 'outstanding',
        cookedAt: null,
        readyAt: null,
      },
    ],
    placedAt: minutesAgo(5, now),
    unrouted: true,
  })

  return rounds
}
