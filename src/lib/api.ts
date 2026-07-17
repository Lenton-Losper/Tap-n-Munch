/**
 * FlashTap Terminal API client
 *
 * Terminal routes: /api/terminal/*
 * Activation route: POST /api/terminals/activate
 */
import {FLASHTAP_API_URL} from '../constants';
import {
  getRefreshToken,
  saveMerchantCredentials,
  saveRefreshToken,
  saveRestaurantId,
  saveRestaurantName,
  saveTerminalId,
  saveTerminalToken,
} from './storage';
import {
  ActivationResponse,
  Order,
  OrderStatus,
  TableWithTab,
} from '../types';
import {mapRowToOrder} from './orderMapper';

interface ApiErrorBody {
  error?: string;
}

interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
}

export class TerminalAuthError extends Error {
  constructor(message = 'Terminal session expired') {
    super(message);
    this.name = 'TerminalAuthError';
  }
}

async function parseApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as ApiErrorBody;
    return data.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function throwIfUnauthorized(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new TerminalAuthError();
  }
}

export async function refreshAccessToken(): Promise<string | null> {
  try {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      return null;
    }

    const response = await fetch(`${FLASHTAP_API_URL}/api/terminal/refresh`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({refreshToken}),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as RefreshTokenResponse;
    await saveTerminalToken(data.accessToken);
    await saveRefreshToken(data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

async function terminalFetch(
  url: string,
  options: RequestInit,
  token: string,
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    const newToken = await refreshAccessToken();
    if (!newToken) {
      throw new TerminalAuthError('Session expired');
    }

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${newToken}`,
      },
    });
  }

  return response;
}

export async function activateTerminal(
  code: string,
): Promise<ActivationResponse> {
  console.log('[activate] FLASHTAP_API_URL:', FLASHTAP_API_URL);
  console.log(
    '[activate] full URL:',
    `${FLASHTAP_API_URL}/api/terminals/activate`,
  );
  console.log('[activate] code being sent:', code);

  const response = await fetch(`${FLASHTAP_API_URL}/api/terminals/activate`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code}),
  });

  const data = (await response.json()) as ActivationResponse & ApiErrorBody;

  if (!response.ok) {
    throw new Error(data.error || 'Activation failed');
  }

  await saveTerminalToken(data.accessToken);
  await saveRefreshToken(data.refreshToken);
  await saveRestaurantId(data.restaurant_id);
  await saveTerminalId(data.terminal_id);
  if (data.restaurant_name) {
    await saveRestaurantName(data.restaurant_name);
  }
  if (data.merchantNo && data.storeNo) {
    await saveMerchantCredentials(data.merchantNo, data.storeNo);
  }

  return data;
}

export async function getOrders(token: string): Promise<Order[]> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as {orders?: Record<string, unknown>[]};
  return (data.orders ?? []).map(row => mapRowToOrder(row));
}

export async function getOrder(
  orderId: string,
  token: string,
): Promise<Order> {
  const orders = await getOrders(token);
  const order = orders.find(o => o.id === orderId);
  if (!order) {
    throw new Error('Order not found');
  }
  return order;
}

export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  token: string,
): Promise<void> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders/${orderId}/status`,
    {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({status}),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
}

export async function sendHeartbeat(
  token: string,
  appVersion: string,
): Promise<void> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/heartbeat`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({appVersion}),
    },
    token,
  );

  throwIfUnauthorized(response);
}

export interface TerminalInfo {
  terminal_id: string;
  restaurant_id: string;
  restaurant_name?: string;
  label?: string;
}

export async function getTerminalInfo(token: string): Promise<TerminalInfo> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/me`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json() as Promise<TerminalInfo>;
}

export interface OrderStreamEvent {
  type: string;
  orderId: string;
  tableNumber?: number;
  status?: string;
}

export function connectToOrderStream(
  token: string,
  onOrderEvent: (event: OrderStreamEvent) => void,
  onConnected: () => void,
  onDisconnected: () => void,
): () => void {
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let isDestroyed = false;
  let abortCurrent: (() => void) | null = null;

  const scheduleReconnect = () => {
    if (isDestroyed) {
      return;
    }
    reconnectTimeout = setTimeout(connect, 5000);
  };

  const connect = async () => {
    if (isDestroyed) {
      return;
    }

    let streamToken = token;
    const controller = new AbortController();
    abortCurrent = () => controller.abort();

    let response = await fetch(`${FLASHTAP_API_URL}/api/terminal/stream`, {
      headers: {Authorization: `Bearer ${streamToken}`},
      signal: controller.signal,
    });

    if (response.status === 401) {
      const newToken = await refreshAccessToken();
      if (!newToken) {
        onDisconnected();
        scheduleReconnect();
        return;
      }
      streamToken = newToken;
      response = await fetch(`${FLASHTAP_API_URL}/api/terminal/stream`, {
        headers: {Authorization: `Bearer ${streamToken}`},
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      onDisconnected();
      scheduleReconnect();
      return;
    }

    try {
      onConnected();
      const reader = response.body?.getReader();
      if (!reader) {
        onDisconnected();
        scheduleReconnect();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const {done, value} = await reader.read();
        if (done || isDestroyed) {
          break;
        }

        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6).trim();
          } else if (line === '' && eventType && eventData) {
            if (eventType !== 'ping') {
              try {
                const parsed = JSON.parse(eventData) as Omit<
                  OrderStreamEvent,
                  'type'
                >;
                onOrderEvent({type: eventType, ...parsed});
              } catch {
                // ignore malformed events
              }
            }
            eventType = '';
            eventData = '';
          }
        }
      }

      if (!isDestroyed) {
        onDisconnected();
        scheduleReconnect();
      }
    } catch {
      if (!isDestroyed) {
        onDisconnected();
        scheduleReconnect();
      }
    }
  };

  connect();

  return () => {
    isDestroyed = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    abortCurrent?.();
  };
}

export async function getTables(token: string): Promise<TableWithTab[]> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tables`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as {tables?: TableWithTab[]};
  return data.tables ?? [];
}

export async function settleTab(
  tabId: string,
  orderIds: string[],
  amount: number,
  gatewayReference: string,
  token: string,
): Promise<{
  payment_reference: string;
  new_tab_total: number;
  can_close: boolean;
}> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tabs/${encodeURIComponent(tabId)}/settle`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        order_ids: orderIds,
        amount,
        gateway_reference: gatewayReference,
        method: 'card',
      }),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json() as Promise<{
    payment_reference: string;
    new_tab_total: number;
    can_close: boolean;
  }>;
}

export async function closeTable(tableId: string, token: string): Promise<void> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tables/${encodeURIComponent(tableId)}/close`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
}

export async function completePayment(
  orderId: string,
  token: string,
  payload: {
    status: 'success' | 'failed';
    reference: string;
    amount: number;
    paymentMethod: 'card';
  },
): Promise<{canClose: boolean}> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders/${orderId}/payment`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error('Payment update failed');
  }

  const data = (await response.json()) as {canClose?: boolean};
  return {canClose: Boolean(data.canClose)};
}

// ─── Authorization / Payment events ───────────────────────────────────────

export interface AuthorizedUser {
  user_id: string;
  name: string;
}

/**
 * Business-logic auth failure (wrong PIN / not authorized).
 * Distinct from TerminalAuthError so callers don't treat it as session expiry.
 */
export class AuthorizationDeniedError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthorizationDeniedError';
    this.status = status;
  }
}

export interface SaleLookupResult {
  business_order_no: string;
  amount: number;
  currency: string;
  order_ids: string[];
  refunded_so_far: number;
  remaining: number;
  sale_recorded_at: string;
}

/**
 * No sale payment event exists for this order — not refundable via this flow.
 */
export class SaleRecordNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleRecordNotFoundError';
  }
}

export async function getSaleRecordForOrder(
  orderId: string,
  token: string,
): Promise<SaleLookupResult> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/payment-events/sale?order_id=${encodeURIComponent(orderId)}`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (response.status === 404) {
    throw new SaleRecordNotFoundError(await parseApiError(response));
  }

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json() as Promise<SaleLookupResult>;
}

export interface PaymentEventRow {
  id: string;
  event_type: string;
  order_ids: string[];
  business_order_no: string;
  origin_business_order_no?: string | null;
  transaction_id?: string | null;
  amount: number;
  reason_code?: string | null;
  reason_note?: string | null;
  gateway_result?: string | null;
  gateway_result_code?: string | null;
  gateway_result_message?: string | null;
  authorized_by_user_id?: string | null;
  authorization_token_id?: string | null;
  created_at?: string;
}

export async function getAuthorizedUsers(
  purpose: string,
  token: string,
): Promise<AuthorizedUser[]> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/authorized-users?purpose=${encodeURIComponent(purpose)}`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as {users?: AuthorizedUser[]};
  return data.users ?? [];
}

/**
 * PIN / staff authorization for a privileged terminal action.
 *
 * IMPORTANT: Does NOT use terminalFetch. A 401 here means "Invalid PIN" (or
 * not authorized), not an expired terminal session. terminalFetch would
 * otherwise refresh the device JWT and retry — which is wrong for this route.
 *
 * throwIfUnauthorized also does not distinguish session vs business 401/403;
 * it blindly throws TerminalAuthError. So this function handles 401/403 itself.
 */
export async function authorizeAction(
  params: {userId: string; pin: string; purpose: string},
  token: string,
): Promise<{token_id: string; expires_at: string}> {
  const response = await fetch(`${FLASHTAP_API_URL}/api/terminal/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      user_id: params.userId,
      pin: params.pin,
      purpose: params.purpose,
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthorizationDeniedError(
      await parseApiError(response),
      response.status,
    );
  }

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json() as Promise<{token_id: string; expires_at: string}>;
}

/**
 * Records a SALE payment event. Does not throw — returns { ok, error? } so the
 * caller can surface a failure to staff without blocking payment success UI.
 * Contrast with recordRefundEvent, which throws on failure.
 */
export async function recordSaleEvent(
  params: {
    orderIds: string[];
    businessOrderNo: string;
    transactionId: string;
    amount: number;
  },
  token: string,
): Promise<{ok: boolean; error?: string}> {
  try {
    const response = await terminalFetch(
      `${FLASHTAP_API_URL}/api/terminal/payment-events/sale`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          order_ids: params.orderIds,
          business_order_no: params.businessOrderNo,
          transaction_id: params.transactionId,
          amount: params.amount,
        }),
      },
      token,
    );

    if (response.status === 401 || response.status === 403) {
      throw new TerminalAuthError();
    }

    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }

    return {ok: true};
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to record sale event';
    console.error('[recordSaleEvent] Failed to record sale payment event', {
      orderIds: params.orderIds,
      businessOrderNo: params.businessOrderNo,
      transactionId: params.transactionId,
      amount: params.amount,
      error,
    });
    return {ok: false, error: message};
  }
}

export async function recordRefundEvent(
  params: {
    tokenId: string;
    userId: string;
    originBusinessOrderNo: string;
    orderIds: string[];
    businessOrderNo: string;
    amount: number;
    reasonCode: string;
    reasonNote?: string;
    gatewayResult: 'success' | 'failure';
    transactionId?: string;
    gatewayResultCode?: string;
    gatewayResultMessage?: string;
  },
  token: string,
): Promise<PaymentEventRow> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/payment-events/refund`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        token_id: params.tokenId,
        user_id: params.userId,
        origin_business_order_no: params.originBusinessOrderNo,
        order_ids: params.orderIds,
        business_order_no: params.businessOrderNo,
        amount: params.amount,
        reason_code: params.reasonCode,
        reason_note: params.reasonNote,
        gateway_result: params.gatewayResult,
        transaction_id: params.transactionId,
        gateway_result_code: params.gatewayResultCode,
        gateway_result_message: params.gatewayResultMessage,
      }),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return response.json() as Promise<PaymentEventRow>;
}

// ─── POS / Menu ────────────────────────────────────────────────────────────

export interface MenuCategory {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  base_price: number;
  is_available: boolean;
  image_url: string | null;
  category_id: string;
}

export interface POSOrderItem {
  menuItemId: string;
  name: string;
  quantity: number;
  basePrice: number;
  subtotal: number;
}

type MenuCategoryGroupResponse = Record<
  string,
  {
    subcategory?: {id: string; name: string; display_order?: number};
    items?: Record<string, unknown>[];
  }
>;

function mapMenuCategory(row: Record<string, unknown>): MenuCategory {
  return {
    id: String(row.id),
    name: String(row.name),
    sort_order: Number(row.sort_order ?? row.display_order ?? 0),
    is_active: Boolean(row.is_active ?? row.active ?? true),
  };
}

function mapMenuItem(row: Record<string, unknown>): MenuItem {
  const status = String(row.status ?? 'available').toLowerCase();
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description != null ? String(row.description) : null,
    base_price: Number(row.base_price ?? 0),
    is_available: status !== 'hidden' && status !== 'unavailable',
    image_url: row.image_url != null ? String(row.image_url) : null,
    category_id: String(row.category_id ?? row.menu_category_id ?? ''),
  };
}

export async function getMenuCategories(
  token: string,
  restaurantId: string,
): Promise<MenuCategory[]> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/menu/${restaurantId}/categories`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as
    | {categories?: Record<string, unknown>[]}
    | Record<string, unknown>[];

  const rows = Array.isArray(data) ? data : (data.categories ?? []);
  return rows.map(row => mapMenuCategory(row));
}

export async function getMenuItems(
  token: string,
  restaurantId: string,
  categoryId: string,
): Promise<MenuItem[]> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/menu/${restaurantId}/category/${categoryId}`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as
    | {items?: Record<string, unknown>[]}
    | MenuCategoryGroupResponse;

  if (Array.isArray((data as {items?: unknown[]}).items)) {
    return ((data as {items: Record<string, unknown>[]}).items ?? []).map(
      row => mapMenuItem(row),
    );
  }

  const items: MenuItem[] = [];
  for (const group of Object.values(data as MenuCategoryGroupResponse)) {
    for (const row of group.items ?? []) {
      items.push(mapMenuItem(row));
    }
  }
  return items;
}

export async function createPOSOrder(
  token: string,
  params: {
    restaurantId: string;
    items: POSOrderItem[];
    subtotal: number;
    total: number;
    orderInstructions?: string;
  },
): Promise<{orderId: string; orderNumber: number}> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(params),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as {
    orderId: string;
    orderNumber: number;
  };
  return data;
}

// ─── Receipt printing (Phase 2) ────────────────────────────────────────────

export interface TerminalReceipt {
  id: string;
  documentNumber: string;
  status: string;
  escposBase64: string;
}

/**
 * Fetches the already-rendered ESC/POS bytes for an order's issued receipt. Returns null
 * (not a throw) when the receipt isn't issued yet — issuance is fire-and-forget server-side
 * (Phase 1), so a brief "not found" right after payment is an expected, retryable state, not
 * an error.
 */
export async function getReceiptForOrder(
  orderId: string,
  token: string,
  characterWidth?: number,
): Promise<TerminalReceipt | null> {
  const query = characterWidth ? `?characterWidth=${characterWidth}` : '';
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/receipts/${orderId}${query}`,
    {method: 'GET'},
    token,
  );

  if (response.status === 401 || response.status === 403) {
    throw new TerminalAuthError();
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  return (await response.json()) as TerminalReceipt;
}

/**
 * Records a print attempt. attempt_number is derived server-side (count of prior attempts
 * for this receipt + 1) — a retry is always a new row, never an edit to a prior attempt.
 * Does not throw — returns { ok, error? } so a logging failure never blocks the retry UX.
 */
export async function recordReceiptDelivery(
  params: {
    receiptDocumentId: string;
    status: 'sent' | 'failed';
    provider?: string;
    errorCode?: string;
    errorMessage?: string;
  },
  token: string,
): Promise<{ok: boolean; error?: string}> {
  try {
    const response = await terminalFetch(
      `${FLASHTAP_API_URL}/api/terminal/receipt-deliveries`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          receipt_document_id: params.receiptDocumentId,
          status: params.status,
          provider: params.provider ?? 'bluetooth_escpos',
          error_code: params.errorCode,
          error_message: params.errorMessage,
        }),
      },
      token,
    );

    if (response.status === 401 || response.status === 403) {
      throw new TerminalAuthError();
    }
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    return {ok: true};
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to record receipt delivery';
    console.error('[recordReceiptDelivery] Failed to record delivery attempt', {
      receiptDocumentId: params.receiptDocumentId,
      status: params.status,
      error,
    });
    return {ok: false, error: message};
  }
}

export interface TerminalPrinterConfig {
  id: string;
  terminal_id: string;
  printer_name: string | null;
  printer_address: string | null;
  paper_width_mm: number;
  character_width: number | null;
}

export async function getPrinterConfig(
  token: string,
): Promise<TerminalPrinterConfig | null> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/printer-config`,
    {method: 'GET'},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as {config: TerminalPrinterConfig | null};
  return data.config;
}

export async function savePrinterConfig(
  params: {
    printerName: string;
    printerAddress: string;
    paperWidthMm?: number;
    characterWidth?: number;
  },
  token: string,
): Promise<TerminalPrinterConfig> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/printer-config`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        printer_name: params.printerName,
        printer_address: params.printerAddress,
        paper_width_mm: params.paperWidthMm ?? 80,
        character_width: params.characterWidth,
      }),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const data = (await response.json()) as {config: TerminalPrinterConfig};
  return data.config;
}
