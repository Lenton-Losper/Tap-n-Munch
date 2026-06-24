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
  table_number: number;
  order_number: number;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  placed_at: string;
  member_name?: string;
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
