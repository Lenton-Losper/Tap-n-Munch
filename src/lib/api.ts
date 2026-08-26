/**
 * FlashTap Terminal API client
 *
 * Terminal routes: /api/terminal/*
 * Activation route: POST /api/terminals/activate
 */
import {APP_VERSION, FLASHTAP_API_URL} from '../constants';
import {recordWiretapEvent} from './wiretap';
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
import type {
  HeldOrphanStoreRequest,
  HeldOrphanStoreResponse,
} from './heldOrphanStore';
import {Sdk6ReceiptLine} from './wiseSdk6Printer';
import {
  isPinLockedError as pinLockedFromFields,
  isRefundAmountExceedsRemaining as refundExceedsFromFields,
  staffMessageForMarkPaidFailure as markPaidMessageFromFields,
  staffMessageForPinLock as pinLockMessageFromFields,
  staffMessageForRefundRecordFailure as refundMessageFromFields,
  staffMessageForSettleFailure as settleMessageFromFields,
} from './staffApiErrors';
interface ApiErrorBody {
  error?: string;
  code?: string;
  expected?: number | null;
  received?: number | null;
  remaining?: number | null;
  sale_amount?: number | null;
  prior_refunded?: number | null;
  retry_after_seconds?: number | null;
  /** #120 residual: the rows blocking a table close, one entry each. */
  pending_requests?: unknown;
}

/**
 * One order request standing between a table and its close (#120 residual).
 *
 * `status` IS THE ONLY FIELD THAT DECIDES WHETHER THE RELEASE ACTION MAY BE OFFERED, and its two
 * values mean opposite things:
 *
 *   waiting_review  a REAL round a customer placed. Staff accept or decline it. Offering to
 *                   release one would let staff dismiss a customer's order — #120's own bug from
 *                   the other side.
 *   accepting       the transient claim the accept route takes. If the worker died between the
 *                   claim and its release the row is stranded, and nothing clears it: there is no
 *                   reaper, and per #215 there cannot be one until the claim records a timestamp.
 *
 * OPTIONAL ON PURPOSE. Servers older than the field omit it, and an absent status must never be
 * guessed at — see isReleasableStrandedRequest, which requires the exact string and therefore
 * offers nothing at all when the field is missing.
 */
export type PendingOrderRequest = {
  id: string;
  placedAt?: string;
  value?: number;
  status?: string;
};

function parsePendingRequests(raw: unknown): PendingOrderRequest[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const rows: PendingOrderRequest[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : String(row.id ?? '');
    if (!id) {
      continue;
    }
    rows.push({
      id,
      placedAt: typeof row.placed_at === 'string' ? row.placed_at : undefined,
      value: typeof row.value === 'number' ? row.value : undefined,
      // Carried through verbatim, never defaulted — see the type's docblock.
      status: typeof row.status === 'string' ? row.status : undefined,
    });
  }
  return rows;
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

/**
 * Structured API failure. `message` stays the backend `error` string so existing
 * `err.message` call sites keep working; `code` / amounts unlock staff copy mapping.
 */
export class ApiRequestError extends Error {
  status: number;
  code?: string;
  expected?: number | null;
  received?: number | null;
  remaining?: number | null;
  saleAmount?: number | null;
  priorRefunded?: number | null;
  retryAfterSeconds?: number | null;
  /** #120 residual. Empty for every error that is not a blocked table close. */
  pendingRequests: PendingOrderRequest[] = [];

  constructor(
    message: string,
    status: number,
    extras?: {
      code?: string;
      expected?: number | null;
      received?: number | null;
      remaining?: number | null;
      saleAmount?: number | null;
      priorRefunded?: number | null;
      retryAfterSeconds?: number | null;
      pendingRequests?: PendingOrderRequest[];
    },
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = extras?.code;
    this.expected = extras?.expected;
    this.received = extras?.received;
    this.remaining = extras?.remaining;
    this.saleAmount = extras?.saleAmount;
    this.priorRefunded = extras?.priorRefunded;
    this.retryAfterSeconds = extras?.retryAfterSeconds;
    this.pendingRequests = extras?.pendingRequests ?? [];
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function parseApiError(response: Response): Promise<ApiRequestError> {
  const fallback = `Request failed (${response.status})`;
  let data: ApiErrorBody = {};
  try {
    data = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON body — keep status-only fallback.
  }

  const retryHeader = response.headers.get('Retry-After');
  const retryFromHeader =
    retryHeader != null && /^\d+$/.test(retryHeader.trim())
      ? Number(retryHeader.trim())
      : null;

  const retryAfterSeconds =
    finiteOrNull(data.retry_after_seconds) ?? retryFromHeader;

  return new ApiRequestError(data.error || fallback, response.status, {
    code: data.code ? String(data.code) : undefined,
    expected: finiteOrNull(data.expected),
    received: finiteOrNull(data.received),
    remaining: finiteOrNull(data.remaining),
    saleAmount: finiteOrNull(data.sale_amount),
    priorRefunded: finiteOrNull(data.prior_refunded),
    retryAfterSeconds,
    pendingRequests: parsePendingRequests(data.pending_requests),
  });
}

function toStaffFields(err: ApiRequestError) {
  return {
    status: err.status,
    message: err.message,
    code: err.code,
    expected: err.expected,
    remaining: err.remaining,
    retryAfterSeconds: err.retryAfterSeconds,
  };
}

export function isPinLockedError(err: unknown): boolean {
  return err instanceof ApiRequestError && pinLockedFromFields(toStaffFields(err));
}

export function staffMessageForPinLock(err: ApiRequestError): string {
  return pinLockMessageFromFields(toStaffFields(err));
}

export function staffMessageForMarkPaidFailure(err: ApiRequestError): string {
  return markPaidMessageFromFields(toStaffFields(err));
}

export function staffMessageForSettleFailure(err: ApiRequestError): string {
  return settleMessageFromFields(toStaffFields(err));
}

export function isRefundAmountExceedsRemaining(err: unknown): boolean {
  return (
    err instanceof ApiRequestError &&
    refundExceedsFromFields(toStaffFields(err))
  );
}

export function staffMessageForRefundRecordFailure(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return refundMessageFromFields(toStaffFields(err));
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Failed to record refund — authorization may have expired. Start again from the table.';
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
    throw await parseApiError(response);
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
    throw await parseApiError(response);
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

/**
 * GET /api/terminal/me — terminal + restaurant config the app already loads at
 * auth time (and on Charge for payment-method flags).
 *
 * Response historically mixed camelCase (API) and snake_case (older clients).
 * Prefer snake_case field names for the payment flags (`card_payment_enabled` /
 * `cash_payment_enabled`); accept camelCase if the web payload uses that.
 */
export interface TerminalInfo {
  terminal_id?: string;
  restaurant_id?: string;
  restaurant_name?: string;
  label?: string;
  terminalId?: string;
  restaurantId?: string;
  restaurantName?: string;
  status?: string;
  permissions?: unknown;
  /** When omitted, treat as enabled (web default: card on). */
  card_payment_enabled?: boolean;
  /** When omitted, treat as enabled so dual Card/Cash UI keeps working until flags ship. */
  cash_payment_enabled?: boolean;
  cardPaymentEnabled?: boolean;
  cashPaymentEnabled?: boolean;
}

export type PaymentMethodsAvailability = {
  cardEnabled: boolean;
  cashEnabled: boolean;
};

/**
 * Resolve Card/Cash availability from /terminal/me.
 * Missing flags default to enabled (card always has historically been available;
 * cash defaults on so Charge keeps today's dual choice until the web team ships
 * explicit false).
 */
export function resolvePaymentMethodsAvailability(
  info: Pick<
    TerminalInfo,
    | 'card_payment_enabled'
    | 'cash_payment_enabled'
    | 'cardPaymentEnabled'
    | 'cashPaymentEnabled'
  > | null | undefined,
): PaymentMethodsAvailability {
  const cardRaw = info?.card_payment_enabled ?? info?.cardPaymentEnabled;
  const cashRaw = info?.cash_payment_enabled ?? info?.cashPaymentEnabled;
  return {
    cardEnabled: cardRaw !== false,
    cashEnabled: cashRaw !== false,
  };
}

export async function getTerminalInfo(token: string): Promise<TerminalInfo> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/me`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
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

export type TablesPayload = {
  tables: TableWithTab[];
  /**
   * How long the server treats a pushed card payment as still live. Read from the
   * payload rather than hardcoded, so the countdown always matches the server that
   * will actually reject the settle.
   */
  cardInFlightTimeoutSeconds: number | null;
};

export async function getTablesWithMeta(
  token: string,
): Promise<TablesPayload> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tables`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as {
    tables?: TableWithTab[];
    card_in_flight_timeout_seconds?: unknown;
  };

  return {
    tables: data.tables ?? [],
    cardInFlightTimeoutSeconds: finiteOrNull(data.card_in_flight_timeout_seconds),
  };
}

export async function getTables(token: string): Promise<TableWithTab[]> {
  return (await getTablesWithMeta(token)).tables;
}

export type SettlementMethod = 'card' | 'cash';

export type SettleTabExtras = {
  voucherNo?: string;
  businessOrderNo?: string;
  /**
   * Who is taking the money. Optional: the server does not gate on attribution, so a
   * settle still succeeds without it and is recorded as terminal_only. Supplied whenever
   * a staff member has authorized via PIN, because an unattributed cash payment at a live
   * venue is a real audit gap.
   */
  staffUserId?: string;
  authorizationTokenId?: string;
};

export type SettleTabResult = {
  success?: boolean;
  payment_reference: string;
  method?: SettlementMethod;
  new_tab_total: number | null;
  /** true when the server could not trust its own recalculation of the tab total. */
  tab_total_stale?: boolean;
  can_close: boolean;
  staff_user_id?: string | null;
};

export async function settleTab(
  tabId: string,
  orderIds: string[],
  amount: number,
  gatewayReference: string,
  token: string,
  extras?: SettleTabExtras,
  // Explicit and required at the call site rather than defaulted here: defaulting is how
  // this shipped as a hardcoded 'card' literal and cash became unreachable.
  method: SettlementMethod = 'card',
): Promise<SettleTabResult> {
  const isCash = method === 'cash';
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tabs/${encodeURIComponent(tabId)}/settle`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        order_ids: orderIds,
        amount,
        method,
        // Cash has no gateway artifacts. Sending empty/stale card references alongside a
        // cash settle is how a cash receipt ends up printing a card-style reference.
        gateway_reference: isCash ? undefined : gatewayReference,
        voucher_no: isCash ? undefined : extras?.voucherNo,
        business_order_no: isCash ? undefined : extras?.businessOrderNo,
        staff_user_id: extras?.staffUserId,
        authorization_token_id: extras?.authorizationTokenId,
      }),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    const err = await parseApiError(response);
    throw new ApiRequestError(
      staffMessageForSettleFailure(err),
      err.status,
      {
        code: err.code,
        expected: err.expected,
        received: err.received,
        remaining: err.remaining,
        saleAmount: err.saleAmount,
        priorRefunded: err.priorRefunded,
        retryAfterSeconds: err.retryAfterSeconds,
      },
    );
  }

  return response.json() as Promise<SettleTabResult>;
}

/**
 * Exchange a staff user id + PIN for a single-use authorization token.
 *
 * 90s TTL, single use, purpose-scoped server-side. Used to attribute a cash settlement
 * to the staff member who took the money.
 */
export async function authorizeTerminalAction(
  userId: string,
  pin: string,
  purpose: 'cash_settlement' | 'refund',
  token: string,
): Promise<{token_id: string; expires_at: string}> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/authorize`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({user_id: userId, pin, purpose}),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    const err = await parseApiError(response);
    // PIN lockout has its own copy and its own retry-after; everything else falls through
    // to the generic authorization message.
    throw new ApiRequestError(
      isPinLockedError(err) ? staffMessageForPinLock(err) : err.message,
      err.status,
      {code: err.code, retryAfterSeconds: err.retryAfterSeconds},
    );
  }

  return response.json() as Promise<{token_id: string; expires_at: string}>;
}

/**
 * #120 residual — may this blocked row be offered the release action?
 *
 * `accepting` AND NOTHING ELSE. This predicate is the whole safety of the button, and it is
 * written as an exact equality rather than "not waiting_review" deliberately: the dangerous
 * direction is showing the action for a row that is a REAL customer order, so any value this
 * client does not recognise — a status added later, or the field missing entirely because the
 * server predates it — must fall on the side of showing nothing.
 *
 * Servers older than the field send no `status` at all, which is exactly the case an
 * `!== 'waiting_review'` form would get wrong: undefined is not 'waiting_review', so the action
 * would be offered for every blocked row on every old server.
 */
export function isReleasableStrandedRequest(row: PendingOrderRequest): boolean {
  return row.status === 'accepting';
}

export type ReleaseStrandedRequestResult = {
  released: boolean;
  /** True when the row was already resolved by something else — still a success. */
  alreadyResolved: boolean;
};

/**
 * Release a stranded `accepting` claim back to `waiting_review` (#120 residual).
 *
 * ALREADY_RESOLVED IS TREATED AS SUCCESS, not as an error. It means the accept route finished its
 * own release while this request was in flight — on a shared floor that is a routine race, two
 * staff tapping the same stuck table. Either way the row is no longer stranded, which is the
 * outcome staff wanted, and the web dashboard's handler counts it the same way so the two
 * surfaces cannot disagree about what happened.
 *
 * NOT_A_STRANDED_CLAIM still throws. It means the row was not `accepting` when the server looked,
 * so this client offered an action it should not have — a real disagreement worth surfacing rather
 * than swallowing.
 */
export async function releaseStrandedRequest(
  requestId: string,
  token: string,
): Promise<ReleaseStrandedRequestResult> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/order-requests/${encodeURIComponent(
      requestId,
    )}/release`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    const err = await parseApiError(response);
    if (err.code === 'ALREADY_RESOLVED') {
      return {released: false, alreadyResolved: true};
    }
    throw err;
  }

  return {released: true, alreadyResolved: false};
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
    throw await parseApiError(response);
  }
}

/**
 * The payment route's 200 body, in full (#327).
 *
 * `outcome` is the discriminator and the field callers must branch on — pass it to
 * classifyFailureReport in lib/paymentReportOutcome rather than interpreting it at the call site,
 * so all three screens agree on what each value means.
 */
export type CompletePaymentResult = {
  canClose: boolean;
  success: boolean;
  outcome?: string;
  reason?: string;
};

export async function completePayment(
  orderId: string,
  token: string,
  payload: {
    status: 'success' | 'failed';
    reference: string;
    amount: number;
    /**
     * Stored as orders.payment_method. Backend accepts any string and defaults to
     * 'card' when omitted. Use 'cash' for terminal cash tender (no Finatic fields).
     */
    paymentMethod: 'card' | 'cash';
    /** Wiseasy/Finatic voucher — stored as orders.payment_voucher_no (not merchant order). */
    voucherNo?: string;
    /** Finatic businessOrderNo — backfills paycloud_merchant_order_no if prepare was skipped. */
    businessOrderNo?: string;
    /**
     * Why the payment failed, when the terminal KNOWS. Currently set only for a user cancel on
     * the reader, as TERMINAL_USER_CANCELLED_REASON. The server matches this EXACTLY -- adjacent
     * values are pinned as non-bypassing -- so it must not be reworded or prefixed.
     */
    cancellationReason?: string;
    /**
     * True ONLY when WiseCashier returned Activity.RESULT_CANCELED, i.e. the operator dismissed
     * the screen before the reader contacted the gateway. Lets the server cancel without a
     * Finatic verify, because no payment order can exist. Never set for an ambiguous outcome.
     */
    noGatewayAttempt?: boolean;
  },
): Promise<CompletePaymentResult> {
  // INSTRUMENTATION (vc84). Record what actually goes on the wire, before it goes.
  //
  // On 2026-08-09 the terminal classified a cancel correctly and the order still did not cancel,
  // and the server audit could not distinguish "terminal never sent the fields" from "route
  // discarded them" — the route read `body` field by field, so both look identical downstream.
  // The route is fixed, but this is the device-side half of that proof and it costs nothing.
  recordWiretapEvent('completePayment.request', {
    orderId,
    status: payload.status,
    reference: payload.reference,
    amount: payload.amount,
    businessOrderNo: payload.businessOrderNo,
    // The two fields the bypass depends on. Recorded explicitly, including when absent, so the
    // log distinguishes "sent false" from "never set".
    cancellationReason: payload.cancellationReason ?? '(not set)',
    noGatewayAttempt:
      payload.noGatewayAttempt === undefined ? '(not set)' : payload.noGatewayAttempt,
  });

  let response: Response;
  try {
    response = await terminalFetch(
      `${FLASHTAP_API_URL}/api/terminal/orders/${orderId}/payment`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      },
      token,
    );
  } catch (err) {
    // Transport failure: the request never completed. Distinguishes "server rejected it" from
    // "it never arrived", which the server side cannot tell us by definition.
    recordWiretapEvent('completePayment.threw', {
      orderId,
      stage: 'fetch',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Body is read from a CLONE: parseApiError and response.json() below both consume the
  // original, and a body can only be read once.
  let bodyText = '(unread)';
  try {
    bodyText = (await response.clone().text()).slice(0, 300);
  } catch {
    bodyText = '(clone failed)';
  }
  recordWiretapEvent('completePayment.response', {
    orderId,
    httpStatus: response.status,
    ok: response.ok,
    body: bodyText,
  });

  throwIfUnauthorized(response);

  if (!response.ok) {
    const err = await parseApiError(response);
    throw new ApiRequestError(
      staffMessageForMarkPaidFailure(err),
      err.status,
      {
        code: err.code,
        expected: err.expected,
        received: err.received,
        remaining: err.remaining,
        saleAmount: err.saleAmount,
        priorRefunded: err.priorRefunded,
        retryAfterSeconds: err.retryAfterSeconds,
      },
    );
  }

  /**
   * #327. THIS USED TO PARSE `{canClose}` AND DISCARD THE REST OF THE BODY.
   *
   * The route answers three materially different facts on this same 200 — the payment was
   * confirmed (`corrected_to_paid`), definitively not taken (`cancelled`), or CANNOT BE CONFIRMED
   * (`left_pending_finatic_uncertain`) — and `outcome` is the only field that separates them. It
   * was being thrown away here, one line from the screen that needed it, which is why order #868's
   * unconfirmed payment reached the operator looking like every other result.
   *
   * `success` is carried too, but see paymentReportOutcome.ts: callers branch on `outcome` first,
   * so this classifies correctly against both the pre-#329 server (which spelled the uncertain
   * outcome `success: true`) and the current one.
   */
  const data = (await response.json()) as {
    canClose?: boolean;
    success?: boolean;
    outcome?: string;
    reason?: string;
  };
  return {
    canClose: Boolean(data.canClose),
    // Absent means an older server that only ever answered on the happy path; do not read the
    // absence as false.
    success: data.success !== false,
    outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
  };
}

/**
 * completePayment with one retry. A swallowed failure here means the backend never learns
 * a card attempt happened — the terminal shows FAILED but the order can be left stuck as
 * "merchant order allocated, no completion" forever. Returns null (never throws) only after
 * both attempts fail, so callers can surface a distinct "contact support" state instead of
 * silently treating the report as handled.
 */
export async function completePaymentReliably(
  orderId: string,
  token: string,
  payload: Parameters<typeof completePayment>[2],
): Promise<CompletePaymentResult | null> {
  try {
    return await completePayment(orderId, token, payload);
  } catch (firstErr) {
    console.warn(
      '[api] completePayment failed, retrying once:',
      firstErr instanceof Error ? firstErr.message : firstErr,
    );
    try {
      return await completePayment(orderId, token, payload);
    } catch (secondErr) {
      console.warn(
        '[api] completePayment retry also failed — backend was not notified:',
        secondErr instanceof Error ? secondErr.message : secondErr,
      );
      return null;
    }
  }
}

/**
 * Allocates (or returns) the backend-owned Finatic merchant_order_no and persists it on
 * orders.paycloud_merchant_order_no before WiseCashier launches. Required so
 * POST /api/webhooks/paycloud can correlate the notify to this order.
 */
export async function prepareTerminalPayment(
  orderId: string,
  token: string,
): Promise<{orderId: string; merchantOrderNo: string; created: boolean}> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders/${orderId}/prepare-payment`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as {
    orderId?: string;
    merchantOrderNo?: string;
    created?: boolean;
  };
  const merchantOrderNo = String(data.merchantOrderNo ?? '').trim();
  if (!merchantOrderNo) {
    throw new Error('prepare-payment did not return merchantOrderNo');
  }

  return {
    orderId: String(data.orderId ?? orderId),
    merchantOrderNo,
    created: Boolean(data.created),
  };
}

export type MarkPaymentAttemptStartedResult = {
  success: boolean;
  recorded: boolean;
  startedAt?: string;
  businessOrderNo?: string;
};

/**
 * Marks that WiseCashier was actually launched for this order (distinct from
 * prepare-payment, which only allocates merchant_order_no). Idempotent — a
 * duplicate may return recorded: false with the original startedAt.
 *
 * See restaurant-menu-screen docs/terminal-attempt-started-handoff.md (PR #89).
 */
export async function markTerminalPaymentAttemptStarted(
  orderId: string,
  token: string,
  opts: {
    businessOrderNo: string;
    appVersion?: string;
    launchedAt?: string;
  },
): Promise<MarkPaymentAttemptStartedResult> {
  const businessOrderNo = String(opts.businessOrderNo ?? '').trim();
  if (!businessOrderNo) {
    throw new Error('businessOrderNo is required for attempt-started');
  }

  const body: Record<string, string> = {businessOrderNo};
  if (opts.appVersion) {
    body.appVersion = opts.appVersion;
  }
  if (opts.launchedAt) {
    body.launchedAt = opts.launchedAt;
  }

  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders/${orderId}/attempt-started`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as {
    success?: boolean;
    recorded?: boolean;
    startedAt?: string;
    businessOrderNo?: string;
  };

  return {
    success: data.success !== false,
    recorded: Boolean(data.recorded),
    startedAt: data.startedAt ? String(data.startedAt) : undefined,
    businessOrderNo: data.businessOrderNo
      ? String(data.businessOrderNo)
      : businessOrderNo,
  };
}

export type VerifyTerminalPaymentResult = {
  ok: boolean;
  paid: boolean;
  source?: string;
  merchantOrderNo?: string | null;
  transactionId?: string | null;
  status?: string;
  amount?: number | null;
  expectedAmount?: number;
  error?: string;
};

/**
 * Ask the backend to query Finatic for this order's merchant_order_no.
 * Used after ambiguous / missing device callbacks so we do not invent FT-FAIL refs.
 */
export async function verifyTerminalPayment(
  orderId: string,
  token: string,
): Promise<VerifyTerminalPaymentResult> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders/${orderId}/verify-payment`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({}),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return response.json() as Promise<VerifyTerminalPaymentResult>;
}

/**
 * #344 RULING 3 — store a held orphan payment durably on the server. The write IS the
 * acknowledgement; the release rule lives in `heldOrphanStore.ts` and reads what this returns.
 *
 * RETURNS THE STATUS INSTEAD OF THROWING ON A NON-2xx, WHICH IS THE POINT. Ruling 3 makes 409 an
 * ACKNOWLEDGEMENT — the record is already stored — so a 409 has to reach the classifier as a status
 * rather than arrive as an exception indistinguishable from a 500. Every other terminal call in this
 * file throws on !ok because for them a non-2xx is uniformly a failure; here it is not.
 *
 * 401/403 STILL THROW, via throwIfUnauthorized, because an expired session must drive the same
 * re-auth as everywhere else. The caller treats the throw as 'not stored', which is correct: we
 * never reached a server that would write anything.
 *
 * THE RESPONSE IS NARROWED TO TWO FIELDS ON PURPOSE (ruling 4). Whatever else the server sends is
 * dropped here rather than passed inward, so a reconciliation field cannot quietly acquire a reader.
 */
export async function storeHeldOrphanPayment(
  body: HeldOrphanStoreRequest,
  token: string,
): Promise<{status: number; body: HeldOrphanStoreResponse | null}> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/held-payments`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    },
    token,
  );

  throwIfUnauthorized(response);

  let parsed: HeldOrphanStoreResponse | null = null;
  try {
    const raw = (await response.json()) as Partial<HeldOrphanStoreResponse>;
    // Narrowed field by field. `stored` is only true when the server said the boolean true, never
    // when it sent a truthy string, because this is the value that deletes a card transaction.
    parsed = {
      stored: raw?.stored === true,
      receiptId: typeof raw?.receiptId === 'string' ? raw.receiptId : '',
    };
  } catch {
    // A 409 may legitimately carry no body, and an error page is not JSON. Either way the status
    // is what the classifier reads.
    parsed = null;
  }

  return {status: response.status, body: parsed};
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
    const err = await parseApiError(response);
    throw new SaleRecordNotFoundError(err.message);
  }

  if (!response.ok) {
    throw await parseApiError(response);
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
    throw await parseApiError(response);
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

  // Parse once — body can only be read once. 429 PIN_LOCKED must not be
  // treated as a generic system/network failure by RefundPinScreen.
  if (!response.ok) {
    const err = await parseApiError(response);
    if (isPinLockedError(err)) {
      throw err;
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthorizationDeniedError(err.message, response.status);
    }
    throw err;
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
          /**
           * #156. WITHOUT THIS THE LEDGER CANNOT DATE ITSELF TO A BUILD. Every one of the 490
           * existing sale rows carries app_version NULL, because this payload never sent it --
           * so when the ledger died on 2026-07-28 and 99.7% of August card payments had no row,
           * the one query that would have bounded the cause in seconds ("which build stopped
           * writing?") could not be asked of the data at all.
           */
          app_version: APP_VERSION,
        }),
      },
      token,
    );

    if (response.status === 401 || response.status === 403) {
      throw new TerminalAuthError();
    }

    if (!response.ok) {
      throw await parseApiError(response);
    }

    return {ok: true};
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to record sale event';
    /**
     * #156. THIS FAILURE RAN AT 99.7% FOR A MONTH AND NOTHING COULD SEE IT.
     *
     * The ledger stopped on 2026-08-28 and the only trace was the console.error below -- on a
     * device, in a restaurant, that nobody reads. Everything else was ruled out from the outside:
     * the endpoint accepts this exact payload (probed, HTTP 200), auth works on these devices
     * (1008 attempt_started rows over the same period), the call exists in every shipped release,
     * and every order carries the voucher and business order number the gate requires. What could
     * NOT be established from outside the device is which of two things happens here --
     * terminalFetch throwing, or the caller's gate evaluating false so this is never reached.
     *
     * That is what this event answers. It is not hygiene; it is the missing instrument, and its
     * absence is why five hypotheses had to be eliminated one at a time.
     *
     * Deliberately NOT rethrown: recording the ledger must never break the payment in progress.
     * The event makes the failure queryable; it does not change what the customer experiences.
     */
    recordWiretapEvent('payment.sale_event.failed', {
      orderIds: params.orderIds.join(','),
      businessOrderNo: params.businessOrderNo,
      transactionId: params.transactionId,
      amount: params.amount,
      appVersion: APP_VERSION,
      error: message,
    });
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
    throw await parseApiError(response);
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
    throw await parseApiError(response);
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
    throw await parseApiError(response);
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
    /**
     * #328. One key per SALE ATTEMPT, from CartContext. REQUIRED, not optional: the whole defect
     * was a client silently not sending it, and an optional field is how that happens again.
     * The server (app/api/terminal/orders/route.ts) treats a repeat of the same key as "this order
     * already exists" and returns the existing row instead of creating a duplicate.
     */
    idempotencyKey: string;
  },
): Promise<{orderId: string; orderNumber: number}> {
  const {idempotencyKey, ...body} = params;
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/orders`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': idempotencyKey,
      },
      // The key travels in the header only; the route reads it there and nowhere else.
      body: JSON.stringify(body),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
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
  /** RCT document number — also embedded in escposBase64 / sdk6Lines by the backend renderer. */
  documentNumber: string;
  status: string;
  escposBase64: string;
  /**
   * Structured counterpart to escposBase64 for the P5 built-in printer (WisePosSdk has no
   * raw-byte write). On the current backend, mark-paid awaits issuance, so a successful
   * payment's GET should include sdk6Lines. Treated as required by printViaBuiltIn; absence
   * is RECEIPT_FORMAT_UNAVAILABLE (contract/backend defect), not a client race.
   */
  sdk6Lines?: Sdk6ReceiptLine[];
  /** Present on current backend responses; unused by the terminal transport layer. */
  issuedAt?: string;
  /** Present on current backend responses; unused by the terminal transport layer. */
  rendererVersion?: string;
}

/**
 * Thrown when GET /receipts/:orderId returns 404. After a successful mark-paid on the current
 * backend, issuance is awaited — this is an anomalous issuance/backend failure, not a normal
 * "wait a moment" race. Diagnostics (paymentStatus, paidAt, issuance audit) are attached when
 * the API returns them.
 */
export class ReceiptNotReadyError extends Error {
  readonly code: string;
  readonly orderId: string;
  readonly diagnostics: Record<string, unknown> | null;

  constructor(
    orderId: string,
    code: string = 'RECEIPT_NOT_READY',
    diagnostics: Record<string, unknown> | null = null,
  ) {
    super(
      diagnostics
        ? `Receipt not issued for order ${orderId} (${code}): ${JSON.stringify(diagnostics)}`
        : `Receipt not issued for order ${orderId} (${code})`,
    );
    this.name = 'ReceiptNotReadyError';
    this.code = code;
    this.orderId = orderId;
    this.diagnostics = diagnostics;
  }
}

/**
 * Fetches the final issued receipt for an order (read-only; does not issue).
 * On 404 throws ReceiptNotReadyError with backend diagnostics when present.
 */
export async function getReceiptForOrder(
  orderId: string,
  token: string,
  characterWidth?: number,
): Promise<TerminalReceipt> {
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
    let code = 'RECEIPT_NOT_READY';
    let diagnostics: Record<string, unknown> | null = null;
    try {
      const body = (await response.json()) as {
        code?: string;
        diagnostics?: Record<string, unknown>;
      };
      code = body.code ?? 'RECEIPT_NOT_READY';
      diagnostics = body.diagnostics ?? null;
    } catch {
      // Body may be empty; still surface a typed not-ready error.
    }
    console.warn('[getReceiptForOrder] RECEIPT_NOT_READY', {
      orderId,
      code,
      diagnostics,
    });
    throw new ReceiptNotReadyError(orderId, code, diagnostics);
  }

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const receipt = (await response.json()) as TerminalReceipt;
  if (!receipt?.id || typeof receipt.escposBase64 !== 'string') {
    throw new Error('Receipt response is missing id or escposBase64');
  }
  return receipt;
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
    /** The terminal's own id -- required for provider 'wiseasy_sdk6' (no printer_address to identify it by). */
    deviceId?: string;
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
          device_id: params.deviceId,
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
      throw await parseApiError(response);
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

/**
 * Emails the receipt for an order to the given address. Unlike printing, sending happens
 * entirely server-side -- this route is assumed to log its own receipt_deliveries row
 * (provider 'email') since the server, not the terminal, knows the outcome; request shape
 * (POST {email}) is confirmed working since real sends have succeeded on staging. Exact error
 * response shape still isn't confirmed -- on failure this throws the full raw response (status
 * + body), not just a parsed .error field, specifically so a caller can route it somewhere
 * inspectable (there's no on-device log access on this hardware -- see
 * sendReceiptEmailForOrder in receiptPrinting.ts, which logs it to receipt_deliveries).
 */
export async function sendReceiptEmail(
  orderId: string,
  email: string,
  token: string,
): Promise<void> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/receipts/${orderId}/email`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email}),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    const rawText = await response.text();
    throw new Error(`status=${response.status} body=${rawText}`);
  }
}

export type TerminalPrinterConnectionType = 'BLUETOOTH' | 'BUILTIN';

export interface TerminalPrinterConfig {
  id: string;
  terminal_id: string;
  /** Defaults to 'BLUETOOTH' when reading configs saved before this field existed. */
  connection_type: TerminalPrinterConnectionType;
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
    throw await parseApiError(response);
  }

  const data = (await response.json()) as {
    config: (Omit<TerminalPrinterConfig, 'connection_type'> & {connection_type?: TerminalPrinterConnectionType}) | null;
  };
  // Configs saved before connection_type existed (or a route that doesn't echo it back yet)
  // come back without the field -- treat that as Bluetooth, the only kind that used to exist.
  return data.config ? {...data.config, connection_type: data.config.connection_type ?? 'BLUETOOTH'} : null;
}

/**
 * printerAddress for BUILTIN: the deployed API validates `printer_address` as a required
 * non-empty string even for built-in printers (error: "printer_address is required").
 * Send the sentinel "BUILTIN" — print routing uses connection_type, not this address.
 */
export async function savePrinterConfig(
  params: {
    connectionType: TerminalPrinterConnectionType;
    printerName: string;
    printerAddress?: string;
    paperWidthMm?: number;
    characterWidth?: number;
  },
  token: string,
): Promise<TerminalPrinterConfig> {
  const printerAddress =
    params.connectionType === 'BUILTIN'
      ? params.printerAddress?.trim() || 'BUILTIN'
      : params.printerAddress;

  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/printer-config`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        connection_type: params.connectionType,
        printer_name: params.printerName,
        printer_address: printerAddress,
        paper_width_mm: params.paperWidthMm ?? 80,
        character_width: params.characterWidth,
      }),
    },
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as {config: TerminalPrinterConfig};
  return data.config;
}

/** "Forget this printer" in Settings. Idempotent -- deleting when nothing is configured still succeeds. */
export async function deletePrinterConfig(token: string): Promise<void> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/printer-config`,
    {method: 'DELETE'},
    token,
  );

  throwIfUnauthorized(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }
}
