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
 * THE SAME LIMITS THE CUSTOMER'S QR SHEET ENFORCES, and for the same reason.
 *
 * `lib/orders/quantity-limits.ts` in the web repo clamps the customer's stepper to 1..20 so nobody
 * builds a line the server will refuse and finds out at submit. The terminal had NO clamp at all:
 * `adjustLineQuantity` added the delta with no ceiling, so a waiter could ring up 30 and discover
 * the refusal with a table waiting. Carried across on the owner's ruling, 2026-09-06.
 *
 * MAX_NOTE_LENGTH matches MAX_INSTRUCTIONS_LENGTH (280) rather than the 140 the old inline note
 * field used. The rounds route refuses a note that is not text and imposes no length of its own, so
 * this is a deliberate house limit, chosen to match what a customer can type about the same dish.
 */
export const MIN_LINE_QUANTITY = 1;
export const MAX_LINE_QUANTITY = 20;
export const MAX_NOTE_LENGTH = 280;

/** Clamped, never rejected: a stepper that stops is kinder than one that errors. */
export function clampLineQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return MIN_LINE_QUANTITY;
  return Math.min(MAX_LINE_QUANTITY, Math.max(MIN_LINE_QUANTITY, Math.round(quantity)));
}

/**
 * Adds a menu item to the basket, with the quantity and note the waiter chose in the item sheet.
 *
 * ONE ITEM, ONE NOTE, DECIDED AT THE MOMENT OF ADDING. This used to add a single un-noted unit and
 * leave the note to a field on the basket row, with a Split button to peel a unit off when a note
 * had to apply to only some of them. That put the note somewhere other than where the waiter was
 * thinking about it, and made per-unit notes a two-step recovery rather than the natural outcome.
 *
 * MERGES ONLY INTO A LINE WITH THE SAME NOTE. Tapping Cappuccino twice with different notes gives
 * two lines, which is the behaviour the owner asked for and falls out of this rule rather than
 * needing a Split affordance. Two taps with NO note still merge, so the ordinary case stays one
 * row. Merging across different notes would silently apply one instruction to units nobody asked
 * it for — a wrong instruction reaching the kitchen is worse than an extra row on screen.
 */
export function addLine(
  lines: RoundLine[],
  item: {id: string; name: string; base_price: number},
  options: {quantity?: number; note?: string} = {},
): RoundLine[] {
  const note = (options.note ?? '').trim();
  const quantity = clampLineQuantity(options.quantity ?? 1);

  const index = lines.findIndex(
    line => line.menuItemId === item.id && line.note.trim() === note,
  );
  if (index >= 0) {
    return lines.map((line, i) =>
      i === index
        ? {...line, quantity: clampLineQuantity(line.quantity + quantity)}
        : line,
    );
  }
  return [
    ...lines,
    {
      lineId: nextLineId(),
      menuItemId: item.id,
      name: item.name,
      unitPrice: Number.isFinite(item.base_price) ? item.base_price : 0,
      quantity,
      note,
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
        ? // Clamped at the top, NOT at the bottom: zero still removes the row, which is the
          // existing behaviour and the only way to delete from the stepper.
          {
            ...line,
            quantity:
              line.quantity + delta <= 0
                ? 0
                : clampLineQuantity(line.quantity + delta),
          }
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
