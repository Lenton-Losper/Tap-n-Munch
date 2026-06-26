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
}

export interface TabOrder {
  id: string;
  order_number: number;
  total: number;
  status: string;
  payment_status: string;
  member_name?: string;
  items: OrderItem[];
  placed_at: string;
}

export interface TableTab {
  id: string;
  status: string;
  total: number;
  unpaid_total: number;
  payment_preference?: string;
  orders: TabOrder[];
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
