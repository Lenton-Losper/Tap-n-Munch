/**
 * Waiter-led service v1 — the pure half of "Add Round".
 *
 * Everything here is deliberately free of React and of `fetch`, so the two rules that will actually
 * cost money if they drift — how a basket line is identified, and what shape leaves the device on
 * POST /api/terminal/rounds — can be pinned by tests rather than by reading a screen.
 *
 * Source of truth: docs/terminal-brief-waiter-led-service-v1.md in the web repo.
 */

/**
 * ONE LINE OF THE BASKET, and note that a line is NOT the same thing as a menu item.
 *
 * The brief's per-line `note` ("medium", "well done") is the field the kitchen reads, and it is
 * what forces this: two ribeyes cooked differently cannot share a line, because a line carries one
 * note. So lines are keyed by their own `lineId`, not by `menuItemId`, and the same menu item may
 * legitimately appear on two lines. `order_instructions` is not a substitute — the brief says so
 * outright: it "cannot say which of three steaks is the rare one".
 */
export interface RoundLine {
  lineId: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  /** Per-line note. Empty string, never undefined, so the editor always has a controlled value. */
  note: string;
}

let lineCounter = 0;

function nextLineId(): string {
  lineCounter += 1;
  return `line_${Date.now().toString(36)}_${lineCounter}`;
}

const segment = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/**
 * The `x-idempotency-key` for ONE ROUND ATTEMPT. MANDATORY on POST /api/terminal/rounds — a
 * request without the header is rejected with 400 IDEMPOTENCY_KEY_REQUIRED.
 *
 * Same contract as #328's sale attempt key and for the same reason: the key must be STABLE across
 * retries of this round — a 500 is explicitly retryable with the same key — and NEW for a
 * genuinely different round, or a double-tap becomes two rounds on the customer's bill. A repeat
 * carrying a key already used returns the ORIGINAL order with 200, which is a success.
 *
 * Distinct prefix from `pos_` so a key seen server-side names the flow that produced it.
 */
export function newRoundIdempotencyKey(): string {
  return `round_${Date.now().toString(36)}_${segment()}${segment()}`;
}

/**
 * `seconds_open` rendered for the floor grid: `1h 15m`, `20m`.
 *
 * THE ARGUMENT IS THE SERVER'S NUMBER, not a subtraction of `opened_at` from the device clock. The
 * brief is explicit: "a terminal that has been on a shelf for a week does not have a trustworthy
 * clock". Callers may add locally-measured ELAPSED time (a duration, which is safe) between
 * refreshes; they must never rebuild the figure from a wall-clock difference.
 */
export function formatSecondsOpen(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return 'just now';
}

/**
 * Adds one unit of a menu item to the basket.
 *
 * MERGES ONLY INTO A LINE THAT HAS NO NOTE. Merging into a noted line would silently apply
 * "well done" to a steak nobody asked to be well done — a wrong instruction reaching the kitchen is
 * worse than an extra row on screen. When every existing line for this item carries a note, a fresh
 * un-noted line is started instead.
 */
export function addLine(
  lines: RoundLine[],
  item: {id: string; name: string; base_price: number},
): RoundLine[] {
  const index = lines.findIndex(
    line => line.menuItemId === item.id && line.note.trim() === '',
  );
  if (index >= 0) {
    return lines.map((line, i) =>
      i === index ? {...line, quantity: line.quantity + 1} : line,
    );
  }
  return [
    ...lines,
    {
      lineId: nextLineId(),
      menuItemId: item.id,
      name: item.name,
      unitPrice: Number.isFinite(item.base_price) ? item.base_price : 0,
      quantity: 1,
      note: '',
    },
  ];
}

/** Quantity adjust. A line driven to zero is removed rather than left as an empty row. */
export function adjustLineQuantity(
  lines: RoundLine[],
  lineId: string,
  delta: number,
): RoundLine[] {
  return lines
    .map(line =>
      line.lineId === lineId
        ? {...line, quantity: line.quantity + delta}
        : line,
    )
    .filter(line => line.quantity > 0);
}

export function removeLine(lines: RoundLine[], lineId: string): RoundLine[] {
  return lines.filter(line => line.lineId !== lineId);
}

export function setLineNote(
  lines: RoundLine[],
  lineId: string,
  note: string,
): RoundLine[] {
  return lines.map(line =>
    line.lineId === lineId ? {...line, note} : line,
  );
}

/**
 * Peels one unit off a line onto a new line of its own.
 *
 * This is what makes per-line notes usable in practice. A waiter taps Ribeye twice — one line,
 * quantity 2 — and only then learns one is rare. Without a split the only way out is to remove the
 * line and re-add both, which loses the note already typed. A no-op on a single-unit line.
 */
export function splitLine(lines: RoundLine[], lineId: string): RoundLine[] {
  const index = lines.findIndex(line => line.lineId === lineId);
  if (index < 0 || lines[index].quantity <= 1) {
    return lines;
  }
  const source = lines[index];
  const next = lines.slice();
  next[index] = {...source, quantity: source.quantity - 1};
  next.splice(index + 1, 0, {...source, lineId: nextLineId(), quantity: 1});
  return next;
}

export function basketCount(lines: RoundLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function basketSubtotal(lines: RoundLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}

export interface RoundRequestItem {
  menuItemId: string;
  name: string;
  quantity: number;
  note?: string;
}

/**
 * The `items` array exactly as POST /api/terminal/rounds wants it.
 *
 * `note` — singular — IS THE KEY TO SEND. The server also accepts `notes` and
 * `specialInstructions` because the cart, the kiosk and the terminal each grew their own spelling,
 * but the brief names `note` and that is what goes on the wire. An empty note is OMITTED rather
 * than sent as `""`, so a blank field cannot read as a deliberate empty instruction.
 *
 * Lines with no `menuItemId` are dropped, not sent. The brief: an item without one is still
 * accepted and still appears — as `unrouted`, on both station screens. Sending one is choosing to
 * create a routing problem for a kitchen, which is never what the device should do on its own.
 */
export function buildRoundItems(lines: RoundLine[]): RoundRequestItem[] {
  const items: RoundRequestItem[] = [];
  for (const line of lines) {
    if (!line.menuItemId || line.quantity <= 0) {
      continue;
    }
    const note = line.note.trim();
    items.push({
      menuItemId: line.menuItemId,
      name: line.name,
      quantity: line.quantity,
      ...(note ? {note} : {}),
    });
  }
  return items;
}

/**
 * Which basket lines an OUT_OF_STOCK 409 was talking about.
 *
 * The server answers with names (`{"item":"Ribeye","ingredient":"Beef"}`), not ids, so the match is
 * by name and is case- and whitespace-insensitive. The brief requires EVERY listed item to light up
 * at once — "do not make them discover one refusal at a time" — so this returns the whole set of
 * affected lineIds rather than the first hit.
 */
export function outOfStockLineIds(
  lines: RoundLine[],
  outOfStock: {item?: string}[],
): string[] {
  const blocked = new Set(
    outOfStock
      .map(entry => (entry.item ?? '').trim().toLowerCase())
      .filter(name => name.length > 0),
  );
  if (blocked.size === 0) {
    return [];
  }
  return lines
    .filter(line => blocked.has(line.name.trim().toLowerCase()))
    .map(line => line.lineId);
}
