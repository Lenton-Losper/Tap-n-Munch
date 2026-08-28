export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled';

/**
 * #327 adds PAYMENT_UNCONFIRMED as a THIRD terminal state, alongside SUCCESS and FAILED.
 *
 * Before it there were only two ways for a payment to end, so "the server cannot confirm this" had
 * to be rendered as one of them, and it was rendered as the wrong one. A state meaning "we do not
 * know" cannot be expressed as a shade of either "paid" or "declined" — that is the defect behind
 * order #868, where N$33 of food was released on a payment that never cleared.
 */
export type PaymentState =
  | 'IDLE'
  | 'PAYMENT_IN_PROGRESS'
  | 'PAYMENT_SUCCESS'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_UNCONFIRMED';

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  variant?: string;
}

export interface Order {
  id: string;
  restaurant_id: string;
  table_id?: string;
  table_number: number;
  order_number: number;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  placed_at: string;
  member_name?: string;
  channel?: string;
  customer_name?: string;
  kiosk_order_number?: number;
  /**
   * Not yet populated by /api/terminal/orders as of this writing — that route
   * neither returns completed orders nor attaches payment projections the way
   * /api/terminal/tables does. See getPaymentProjections in the web repo.
   */
  payment_status?: string;
  payment_status_derived?: 'paid' | 'partially_refunded' | 'refunded' | null;
  refunded_amount?: number;
}

export interface TabOrder {
  id: string;
  order_number: number;
  total: number;
  status: string;
  payment_status: string;
  payment_status_derived?: 'paid' | 'partially_refunded' | 'refunded' | null;
  refunded_amount?: number;
  member_name?: string;
  items: OrderItem[];
  placed_at: string;
  /**
   * Settlement affordances computed BY THE SERVER (/api/terminal/tables).
   *
   * Never re-derive these from payment_status on the client. The server owns the
   * settleable-status sets, and a second definition here is exactly how the two drift
   * apart. Optional only so an older server response degrades rather than crashes.
   */
  can_settle_card?: boolean;
  can_settle_cash?: boolean;
  /** A card payment is live on the reader for this order; cash must be refused. */
  card_payment_in_flight?: boolean;
  /** How long that card attempt has been running, per the server's clock. */
  card_in_flight_seconds?: number | null;
}

export interface TableTab {
  id: string;
  status: string;
  total: number;
  unpaid_total: number;
  /**
   * The counts that make `unpaid_total: 0` legible. Zero owed with a paid order is a settled
   * tab; zero owed with nothing billed is a tab whose orders were all CANCELLED — and those two
   * are indistinguishable from `unpaid_total` alone, which is how a NAD 19 tab at Digi Cofee
   * rendered as PAID IN FULL on 2026-08-28 with no money ever taken.
   *
   * OPTIONAL because an older worker does not send them, and `deriveTabSettlementState` falls
   * back to scanning `orders`. An APK reaches a venue before the worker does, and the reverse,
   * so neither half may assume the other is already there.
   */
  paid_order_count?: number;
  unpaid_order_count?: number;
  billable_order_count?: number;
  order_count?: number;
  payment_preference?: string;
  orders: TabOrder[];
  /**
   * Set when the tab first became ready to pay; preserved across a partial
   * settle (some diners paid, some money still owed) so the client can tell
   * "still waiting on some of this tab" apart from "nobody has paid yet".
   *
   * IT IS RETURNED BY /api/terminal/tables. This comment used to say "Not yet
   * returned", which was already false: the route both SELECTS and maps the
   * column (origin/main 141677a1, route.ts:56 and :204), and it reaches the
   * screen intact because getTablesWithMeta (lib/api.ts:614-637) passes
   * `data.tables` straight through with no whitelist mapper. The identical
   * stale claim was corrected on TablesScreen.tsx:58-63 and left standing
   * here, because the two sites were fixed separately — and read on its own
   * this line says #318's chip shipped inert, which it did not.
   *
   * STILL OPTIONAL, but for the deploy rather than for the route: a worker
   * rollout is gradual and can be rolled back, so a response that predates
   * #341 must degrade to undefined rather than crash the chip.
   */
  ready_to_pay_at?: string | null;
}

export interface TableWithTab {
  id: string;
  table_number: number;
  status: string;
  tab: TableTab | null;
  can_close: boolean;
}

export interface Terminal {
  id: string;
  restaurant_id: string;
  token: string;
  label?: string;
}

export interface ActivationResponse {
  accessToken: string;
  refreshToken: string;
  restaurant_id: string;
  terminal_id: string;
  restaurant_name?: string;
  merchantNo?: string;
  storeNo?: string;
}

export type PaymentAction =
  | {type: 'START_PAYMENT'; orderId: string; amount: number}
  | {type: 'PAYMENT_SUCCESS'; reference: string}
  | {type: 'PAYMENT_FAILED'; error: string}
  /**
   * #327. `detail` is a COMPLETE sentence chosen by the caller from constants/paymentCopy, never a
   * fragment to be appended to something else — see #326's dangling em dash. Optional because the
   * screen's own standing instruction is the load-bearing text; the detail only adds specifics.
   */
  | {type: 'PAYMENT_UNCONFIRMED'; detail?: string}
  | {type: 'RESET'}
  | {type: 'RESTORE'; payload: PaymentMachineState};

export interface PaymentMachineState {
  state: PaymentState;
  orderId?: string;
  amount?: number;
  reference?: string;
  error?: string;
}
