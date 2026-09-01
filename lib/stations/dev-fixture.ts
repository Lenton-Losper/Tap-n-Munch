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
import type { BarLineState, BarRound, KitchenLine } from '@/lib/stations/types'

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
 * A FULL BOARD — FORTY ROUNDS (extended from twenty, second-pass redesign 20260829). THE LAYOUT
 * QUESTION ONLY EXISTS AT THIS SIZE.
 * ============================================================================================
 *
 * The small fixture above is for the unit render test and proves nothing about the wall: a
 * handful of rounds fit any layout. This one is deliberately hostile to the layout, and every
 * awkward case in it is one that has actually reached a real board:
 *
 *   - FORTY table groups: twenty-three outstanding, seven cooked-and-waiting (all ACTIVE), ten
 *     READY.
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

  /**
   * ============================================================================================
   * EXTENDED TO FORTY, second-pass redesign (20260829): "screenshot at 1920x1080 with 40 rounds,
   * both boards." Same proportions as the twenty-round set above (roughly a quarter Ready, the
   * rest Active), same realism rule — every awkward shape above still applies, this just makes
   * there be twice as much of it.
   * ============================================================================================
   */
  // ---- READY, PINNED — five more, five more escalation examples -----------------------------
  { table: '22', placed: 5, cooked: 2, ready: 1, items: [['Grilled prawns', 1]] },
  { table: '23', placed: 11, cooked: 6, ready: 4, items: [['Duck breast', 1, 'pink']] },
  { table: '25', placed: 19, cooked: 13, ready: 8, items: [['Lamb curry', 1], ['Poppadums', 2]] },
  { table: '27', placed: 260, cooked: 250, ready: 245, items: [['Beef tartare', 1]] },
  { table: '28', placed: 8, cooked: 3, ready: 2, items: [['Mussels marinière', 1]] },

  // ---- ACTIVE, cooked-and-waiting — four more -------------------------------------------------
  { table: '24', placed: 9, cooked: 3, items: [['Seared tuna', 1, 'rare']] },
  { table: '26', placed: 17, cooked: 6, items: [['Pork ribs', 1], ['Corn bread', 1]] },
  { table: '29', placed: 12, cooked: 5, items: [['Mushroom risotto', 1]] },
  { table: '32', placed: 23, cooked: 9, items: [['Chicken parmigiana', 1]] },

  // ---- ACTIVE, not yet started — eleven more ---------------------------------------------------
  { table: '20', placed: 4, items: [['Nachos', 1]] },
  { table: '30', placed: 13, items: [['Beef burger', 2, 'one no cheese'], ['Sweet potato fries', 1]] },
  { table: '31', placed: 27, items: [['Fish curry', 1], ['Basmati rice', 1]] },
  { table: '33', placed: 1, items: [['Bruschetta', 1]] },
  { table: '34', placed: 16, items: [['Vegetable lasagne', 1], ['Garlic bread', 1]] },
  { table: '35', placed: 32, items: [['Pulled pork sandwich', 1], ['Coleslaw', 1]] },
  { table: '36', placed: 6, items: [['Greek salad', 1]] },
  {
    table: '37',
    placed: 22,
    items: [['Surf and turf', 1], ['Calamari starter', 1], ['Onion rings', 1], ['Chips', 2]],
  },
  { table: '38', placed: 10, items: [['Chicken schnitzel', 2]] },
  { table: '39', placed: 3, items: [['Caprese salad', 1]] },
  // Shared with the bar, independent of its bar half — same shape as table 19 above.
  { table: '40', placed: 14, items: [['Cheese platter', 1], ['Crackers', 1]], routeTo: 'both' },
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
 * The bar at the same volume — forty rounds (extended from twenty, second-pass redesign
 * 20260829), same split as the kitchen: a quarter already poured and waiting for collection, the
 * rest still to make. Same shapes the kitchen fixture exercises (an absent table, an unrouted
 * round, item counts from one to four, ages from seconds to 12877 minutes) so the two boards can
 * be read side by side and any difference between them is a design decision rather than a
 * difference in the data.
 *
 * BOTH ZONES NOW AGE, ON DIFFERENT BANDS. TO MAKE was ruled neutral, then reversed at real volume
 * — see lib/stations/age.ts's barActiveEscalation/barReadyEscalation. The ages below are chosen to
 * discriminate under THOSE (later-than-kitchen) bands, not the kitchen's own.
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

  /**
   * ============================================================================================
   * EXTENDED TO FORTY, second-pass redesign (20260829) — same proportions as the twenty-round set
   * above, plus the red/stale TO MAKE examples the first twenty could not show (every one of them
   * sat under 20 minutes, before TO MAKE had bands of its own to discriminate against).
   * ============================================================================================
   */
  // ---- WAITING FOR COLLECTION — five more --------------------------------------------------
  { table: '22', placed: 3, ready: 1, items: [['Negroni', 1]] },
  { table: '24', placed: 9, ready: 4, items: [['Bloody Mary', 1]] },
  { table: '26', placed: 25, ready: 11, items: [['Whisky sour', 2]] },
  { table: '29', placed: 260, ready: 250, items: [['Draught', 3]] },
  { table: '31', placed: 6, ready: 2, items: [['Margarita', 1]] },

  // ---- TO MAKE — fifteen more, including the red/stale bands the first twenty never reached --
  { table: '20', placed: 5, items: [['Espresso', 2]] },
  { table: '23', placed: 35, items: [['Long island iced tea', 1]] }, // red (>= 30)
  { table: '25', placed: 300, items: [['Rooibos', 1]] }, // stale (>= 240)
  { table: '27', placed: 2, items: [['Diet coke', 3]] },
  { table: '28', placed: 12, items: [['Mai tai', 1], ['Piña colada', 1]] },
  { table: '30', placed: 40, items: [['Manhattan', 1]] }, // red
  { table: '32', placed: 7, items: [['Lime and soda', 2]] },
  { table: '33', placed: 18, items: [['Craft cider', 2]] },
  { table: '34', placed: 1, items: [['Fresh orange juice', 1]] },
  { table: '35', placed: 22, items: [['Rum and coke', 2]] },
  { table: '36', placed: 33, items: [['Negroni sbagliato', 1]] }, // red
  { table: '37', placed: 4, items: [['Sparkling water', 2]] },
  { table: '38', placed: 16, items: [['White wine spritzer', 1]] },
  { table: '39', placed: 8, items: [['Hot toddy', 1]] },
  { table: '40', placed: 10, items: [['Amarula', 2]] },
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

  // The forty-first card: unrouted, and therefore carrying no controls at all — not counted in
  // the forty, same convention the kitchen fixture uses for its own unrouted extra.
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

/* ============================================================================================
 * KDS REDESIGN SCENARIOS — 2026-09-01. Local visual QA only, same rules as the fixtures above:
 * no auth, no network, frozen clock, not linked from anywhere the real app can reach.
 *
 * Two volumes, because the redesign's whole claim is that the board behaves differently at each:
 * QUIET must give Active the space an empty Ready gives back; BUSY must stay readable and must
 * never grow sideways. Both carry the same four things worth looking at — a multi-item card, an
 * allergy note, an urgent (red) order, and a collapsed OLDER UNRESOLVED section.
 * ==========================================================================================*/

function kline(
  now: number,
  id: string,
  tableNumber: string,
  itemName: string,
  quantity: number,
  minutesAgo: number,
  extra: Partial<KitchenLine> = {},
): KitchenLine {
  const placedAt = new Date(now - minutesAgo * 60_000).toISOString()
  return {
    id,
    orderId: `o-${id}`,
    tableNumber,
    orderNumber: Number(id.replace(/\D/g, '')) || 1,
    itemName,
    quantity,
    lineNote: null,
    routeTo: 'kitchen',
    state: 'outstanding',
    placedAt,
    cookedAt: null,
    readyAt: null,
    unrouted: false,
    sharedWithOtherStation: false,
    ...extra,
  }
}

/** 3 active cards + 1 ready + 2 partitioned. Table 6 is multi-item; table 2 carries the allergy;
 *  table 9 is 26 minutes old, which is red on the outstanding bands. */
export function buildKitchenQuietScenario(now: number): KitchenLine[] {
  const old = 14 * 60
  return [
    kline(now, 'q1', '9', 'Ribeye', 1, 26),
    kline(now, 'q2', '2', 'Chicken burger', 2, 11, { lineNote: 'NO NUTS — anaphylactic' }),
    kline(now, 'q3', '6', 'Fish & chips', 2, 4),
    kline(now, 'q4', '6', 'Caesar salad', 1, 4),
    kline(now, 'q5', '6', 'Garlic bread', 3, 4),
    kline(now, 'q6', '4', 'Cheese toast', 2, 6, {
      state: 'ready',
      readyAt: new Date(now - 6 * 60_000).toISOString(),
    }),
    kline(now, 'q7', '1', 'Lamb curry', 1, old),
    kline(now, 'q8', '1', 'Rice', 2, old),
  ]
}

/** ~12 active cards + 4 ready + 3 partitioned. The volume case. */
export function buildKitchenBusyScenario(now: number): KitchenLine[] {
  const old = 15 * 60
  const menu = [
    'Ribeye', 'Beef burger', 'Fish & chips', 'Lamb shank', 'Chicken schnitzel', 'Beef lasagna',
    'Pork belly', 'Prawn linguine', 'Veg curry', 'Steak sandwich', 'Chicken wrap', 'Fillet',
  ]
  const lines: KitchenLine[] = menu.map((name, i) =>
    kline(now, `b${i}`, String(i + 1), name, (i % 3) + 1, 3 + i * 2),
  )
  // A multi-item card, an allergy, and a very old (red) ticket.
  lines.push(kline(now, 'b-extra1', '3', 'Side salad', 2, 7))
  lines.push(kline(now, 'b-extra2', '3', 'Onion rings', 1, 7))
  lines[1] = { ...lines[1], lineNote: 'SHELLFISH ALLERGY — separate pan' }
  lines[0] = { ...lines[0], placedAt: new Date(now - 31 * 60_000).toISOString() }
  // Ready queue.
  for (const [i, name] of ['Cheese toast', 'Chips', 'Soup', 'Bruschetta'].entries()) {
    lines.push(
      kline(now, `br${i}`, String(14 + i), name, (i % 2) + 1, 5 + i, {
        state: 'ready',
        readyAt: new Date(now - (3 + i) * 60_000).toISOString(),
      }),
    )
  }
  for (const [i, name] of ['Bobotie', 'Sausage roll', 'Pie'].entries()) {
    lines.push(kline(now, `bo${i}`, String(20 + i), name, 1, old + i * 30))
  }
  return lines
}

function bround(
  now: number,
  id: string,
  tableNumber: string,
  minutesAgo: number,
  items: Array<[string, number, BarLineState?, string?]>,
): BarRound {
  return {
    id,
    tableNumber,
    orderNumber: Number(id.replace(/\D/g, '')) || 1,
    placedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    unrouted: false,
    items: items.map(([itemName, quantity, state = 'outstanding', note], i) => ({
      id: `${id}-i${i}`,
      itemName,
      quantity,
      lineNote: note ?? null,
      state,
      cookedAt: null,
      readyAt: state === 'ready' ? new Date(now - Math.max(1, minutesAgo - 2) * 60_000).toISOString() : null,
    })),
  }
}

/** Bar equivalent of the quiet scenario. */
export function buildBarQuietScenario(now: number): BarRound[] {
  const old = 14 * 60
  return [
    bround(now, 'bq1', '9', 34, [['Espresso martini', 2]]),
    bround(now, 'bq2', '2', 12, [['Gin & tonic', 1, 'outstanding', 'NO ICE — allergy']]),
    bround(now, 'bq3', '6', 5, [['Cappuccino', 2], ['Flat white', 1], ['Still water', 3]]),
    bround(now, 'bq4', '4', 8, [['Coke', 2, 'ready']]),
    bround(now, 'bq5', '1', old, [['House red', 2], ['Sparkling water', 1]]),
  ]
}

/** Bar equivalent of the busy scenario. */
export function buildBarBusyScenario(now: number): BarRound[] {
  const old = 15 * 60
  const drinks = [
    'Cappuccino', 'Americano', 'Flat white', 'Gin & tonic', 'House red', 'Draught lager',
    'Espresso martini', 'Sparkling water', 'Coke', 'Iced tea', 'Mojito', 'Rooibos',
  ]
  const rounds: BarRound[] = drinks.map((d, i) =>
    bround(now, `bb${i}`, String(i + 1), 3 + i * 2, [[d, (i % 3) + 1]]),
  )
  rounds[2] = bround(now, 'bb2', '3', 9, [
    ['Cappuccino', 2],
    ['Flat white', 1],
    ['Hot chocolate', 1, 'outstanding', 'OAT MILK ONLY — dairy allergy'],
  ])
  rounds[0] = bround(now, 'bb0', '1', 33, [['Cappuccino', 2]])
  rounds.push(bround(now, 'bbr1', '14', 6, [['Coke', 2, 'ready'], ['Fanta', 1, 'ready']]))
  rounds.push(bround(now, 'bbr2', '15', 5, [['Still water', 3, 'ready']]))
  rounds.push(bround(now, 'bbo1', '20', old, [['House white', 2]]))
  rounds.push(bround(now, 'bbo2', '21', old + 45, [['Craft IPA', 1]]))
  return rounds
}

/** 20-order volume: the DENSE tier's boundary. Mixed card heights on purpose — a third of the
 *  cards carry two or three items so the packing behaviour is visible rather than theoretical. */
export function buildKitchenVolumeScenario(now: number, cards: number): KitchenLine[] {
  const names = [
    'Ribeye', 'Beef burger', 'Fish & chips', 'Lamb shank', 'Chicken schnitzel', 'Beef lasagna',
    'Pork belly', 'Prawn linguine', 'Veg curry', 'Steak sandwich', 'Chicken wrap', 'Fillet',
    'Bobotie', 'Oxtail', 'Kingklip', 'Bunny chow', 'Boerewors', 'Calamari', 'Gnocchi', 'Risotto',
  ]
  const sides = ['Chips', 'Side salad', 'Onion rings', 'Garlic bread', 'Mash']
  const lines: KitchenLine[] = []
  for (let i = 0; i < cards; i += 1) {
    const table = String(i + 1)
    const age = 3 + i * 1.5
    lines.push(kline(now, `v${i}`, table, names[i % names.length], (i % 3) + 1, age))
    // Every third table is a multi-item card; every seventh gets a third line.
    if (i % 3 === 1) lines.push(kline(now, `v${i}b`, table, sides[i % sides.length], 1, age))
    if (i % 7 === 3) lines.push(kline(now, `v${i}c`, table, sides[(i + 2) % sides.length], 2, age))
    if (i === 1) {
      lines[lines.length - 1] = { ...lines[lines.length - 1], lineNote: 'NO GLUTEN — coeliac' }
    }
  }
  for (const [i, name] of ['Cheese toast', 'Soup', 'Bruschetta'].entries()) {
    lines.push(
      kline(now, `vr${i}`, String(90 + i), name, (i % 2) + 1, 5 + i, {
        state: 'ready',
        readyAt: new Date(now - (3 + i) * 60_000).toISOString(),
      }),
    )
  }
  lines.push(kline(now, 'vo1', '99', 'Lamb curry', 1, 15 * 60))
  lines.push(kline(now, 'vo2', '98', 'Rice', 2, 16 * 60))
  return lines
}

/** Bar equivalent of the volume scenario. */
export function buildBarVolumeScenario(now: number, cards: number): BarRound[] {
  const drinks = [
    'Cappuccino', 'Americano', 'Flat white', 'Gin & tonic', 'House red', 'Draught lager',
    'Espresso martini', 'Sparkling water', 'Coke', 'Iced tea', 'Mojito', 'Rooibos',
    'Latte', 'Hot chocolate', 'Craft IPA', 'House white', 'Negroni', 'Chai', 'Fanta', 'Cortado',
  ]
  const extras = ['Still water', 'Lemonade', 'Espresso', 'Ginger beer']
  const rounds: BarRound[] = []
  for (let i = 0; i < cards; i += 1) {
    const items: Array<[string, number, BarLineState?, string?]> = [
      [drinks[i % drinks.length], (i % 3) + 1],
    ]
    if (i % 3 === 1) items.push([extras[i % extras.length], 1])
    if (i % 7 === 3) items.push([extras[(i + 1) % extras.length], 2])
    if (i === 1) items[0] = [items[0][0], items[0][1], 'outstanding', 'OAT MILK ONLY — dairy allergy']
    rounds.push(bround(now, `bv${i}`, String(i + 1), 3 + i * 1.5, items))
  }
  rounds.push(bround(now, 'bvr1', '90', 6, [['Coke', 2, 'ready'], ['Fanta', 1, 'ready']]))
  rounds.push(bround(now, 'bvr2', '91', 5, [['Still water', 3, 'ready']]))
  rounds.push(bround(now, 'bvo1', '99', 15 * 60, [['House white', 2]]))
  return rounds
}
