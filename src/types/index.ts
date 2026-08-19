export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled';

export type PaymentState =
  | 'IDLE'
  | 'PAYMENT_IN_PROGRESS'
  | 'PAYMENT_SUCCESS'
  | 'PAYMENT_FAILED';

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
  payment_preference?: string;
  orders: TabOrder[];
  /**
   * Set when the tab first became ready to pay; preserved across a partial
   * settle (some diners paid, some money still owed) so the client can tell
   * "still waiting on some of this tab" apart from "nobody has paid yet".
   * Not yet returned by /api/terminal/tables — optional so older/current
   * server responses degrade to undefined rather than crash.
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
  | {type: 'RESET'}
  | {type: 'RESTORE'; payload: PaymentMachineState};

export interface PaymentMachineState {
  state: PaymentState;
  orderId?: string;
  amount?: number;
  reference?: string;
  error?: string;
}
