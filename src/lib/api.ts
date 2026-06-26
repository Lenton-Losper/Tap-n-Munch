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
): Promise<void> {
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
}
