/**
 * FlashTap Terminal API client
 *
 * Terminal routes: /api/terminal/*
 * Activation route: POST /api/terminals/activate
 */
import {APP_VERSION, FLASHTAP_API_URL} from '../constants';
import {recordWiretapEvent} from './wiretap';
import {TabLinesPayload} from './tabLines';
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
import type {AmendResult, LineAmendment} from './amendTabLines';
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
  /** PIN_MISMATCH on POST /api/terminal/authorize. Absent on every other route. */
  attempts_remaining?: number | null;
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
  /** Wrong-PIN attempts left before lockout. Only POST /authorize sends it. */
  attemptsRemaining?: number | null;
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
      attemptsRemaining?: number | null;
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
    this.attemptsRemaining = extras?.attemptsRemaining;
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
    attemptsRemaining: finiteOrNull(data.attempts_remaining),
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
  /**
   * Waiter-led service v2. `true` = counter service (today's Sale flow), `false` = table service
   * (floor grid, tabs, rounds). Read server-side from `restaurants.is_counter_service` at REQUEST
   * TIME and deliberately not carried in the 1h terminal JWT, so a venue changing model takes
   * effect on the next poll rather than up to an hour later.
   *
   * ABSENT MEANS UNKNOWN, AND UNKNOWN MEANS LEAVE THE APP ALONE. Never read a missing field as
   * table service — that would strip the Sale tab off every terminal running an older deploy or
   * served a cached response. lib/serviceModel.ts is the only thing allowed to interpret this.
   */
  isCounterService?: boolean;
  is_counter_service?: boolean;
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

/**
 * #265 — what `POST /api/tabs/[tabId]/reset-pin` answers with.
 *
 * `recoveryUrl` is the whole payload: a menu URL carrying a single-use `pinReset` token with a
 * 15-minute TTL. The customer opens it and the guest half mints a FRESH PIN and returns it to that
 * device — the reset route deliberately never touches `tab_pin`, so no PIN exists to leak here.
 */
export interface ResetTabPinResult {
  ok: boolean;
  recoveryUrl: string;
  /**
   * When the token dies, as the SERVER reckons it. Null when the server did not send it — the
   * screen then falls back to the route's documented 15-minute TTL rather than showing the code
   * forever. Never compared against the device clock directly; see lib/tabRecoveryExpiry for why.
   */
  expiresAt: string | null;
}

/**
 * Start PIN recovery for a tab. Requires `orders:update`; the server answers 403 without it.
 *
 * THERE IS NO PIN IN THIS RESPONSE AND THERE MUST NEVER BE ONE. #265's ruling (Q1:A) is that staff
 * never see a customer's PIN, and the route enforces that by minting only a token. If some future
 * server starts returning a PIN, it must not be read here — narrow the parse rather than widen it.
 */
export async function resetTabPin(
  tabId: string,
  token: string,
): Promise<ResetTabPinResult> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/tabs/${tabId}/reset-pin`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({}),
    },
    token,
  );

  /**
   * 401 AND 403 ARE SPLIT HERE, AND THIS ROUTE DELIBERATELY DOES NOT USE throwIfUnauthorized.
   *
   * That helper maps BOTH to TerminalAuthError("Terminal session expired"), which is right for
   * every other call in this file — they are not permission-gated, so a 403 there really does mean
   * the session is bad. This one IS permission-gated: the route requires `orders:update`, so a 403
   * is a live, authenticated terminal being told it may not do this.
   *
   * Collapsing the two would tell staff their session expired when it has not, and offer them a
   * retry that can never succeed — the same retry-loop shape as #354. So 401 keeps the existing
   * meaning and 403 arrives as an ApiRequestError the screen can render as "ask a manager".
   *
   * The general case is worth someone's attention: any future permission-gated route added to this
   * file will inherit the same conflation from throwIfUnauthorized.
   */
  if (response.status === 401) {
    throw new TerminalAuthError();
  }

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const body = (await response.json()) as Partial<ResetTabPinResult>;
  // Narrowed field by field, so nothing the server adds later acquires a reader by accident.
  return {
    ok: body.ok === true,
    recoveryUrl: typeof body.recoveryUrl === 'string' ? body.recoveryUrl : '',
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
  };
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
  /**
   * The server's `code`, carried so a caller can tell the two 401/403 cases apart.
   * `PIN_MISMATCH` (401) means "wrong PIN, ask again". A bare 403 means this person cannot do
   * this at all — not a member, no permission, or no PIN set — and re-prompting is pointless.
   * Optional: nothing before waiter-led service read it, and older servers omit it.
   */
  code?: string;
  /** Wrong-PIN attempts left before lockout, when the server says. */
  attemptsRemaining?: number | null;

  constructor(
    message: string,
    status: number,
    extras?: {code?: string; attemptsRemaining?: number | null},
  ) {
    super(message);
    this.name = 'AuthorizationDeniedError';
    this.status = status;
    this.code = extras?.code;
    this.attemptsRemaining = extras?.attemptsRemaining;
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
      throw new AuthorizationDeniedError(err.message, response.status, {
        code: err.code,
        attemptsRemaining: err.attemptsRemaining,
      });
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

// ─── Waiter-led service v1 ────────────────────────────────────────────────────
//
// Contract: docs/terminal-brief-waiter-led-service-v1.md (web repo).
//
// THESE ROUTES DO NOT USE throwIfUnauthorized, AND THAT IS THE WHOLE POINT.
//
// throwIfUnauthorized collapses 401 and 403 into one TerminalAuthError. For every route written
// before this feature that was harmless, because both meant "the device cannot do this". Here it
// would destroy the only signal that matters: the service routes answer 403 with an
// `AUTHORIZATION_*` code for every PIN failure and reserve 401 for an expired TERMINAL token.
// Turning a 403 AUTHORIZATION_EXPIRED into TerminalAuthError would send the device into
// refresh-and-retry against a problem no token refresh can fix — the failure class that produced
// #327. So these call throwIfTerminalSessionExpired (401 only) and let 403 through as a coded
// ApiRequestError the screen branches on.
//
// terminalFetch still does the right thing on 401: refresh once and retry. POST /authorize is the
// one endpoint that must bypass it, and authorizeAction above already does.

/** 401 ONLY. See the block comment above for why this is not throwIfUnauthorized. */
function throwIfTerminalSessionExpired(response: Response): void {
  if (response.status === 401) {
    throw new TerminalAuthError();
  }
}

export interface FloorTableOwner {
  user_id: string;
  name: string;
  assigned_at?: string | null;
}

export interface FloorTableTab {
  id: string;
  status: string;
  total: number;
  opened_by_user_id?: string | null;
}

export interface FloorTable {
  id: string;
  table_number: number;
  table_name: string | null;
  /**
   * THE ONLY THING THAT DECIDES OPEN VS FREE. Computed server-side from the live tab.
   * `table_status` is returned for diagnosis and disagrees with reality in both directions
   * (#216, and the abandoned-tab reaper) — never render from it.
   */
  state: 'open' | 'free';
  /**
   * The table's CURRENT owner, which is not necessarily `tab.opened_by_user_id` — they differ
   * after a handover, correctly. Null on an open table is legitimate (a QR-opened tab, or an
   * assignment that failed while the tab succeeded): show the table as open with no name.
   */
  owner: FloorTableOwner | null;
  opened_at: string | null;
  /** Server-computed. Use this, not the device clock — see formatSecondsOpen. */
  seconds_open: number | null;
  tab: FloorTableTab | null;
  /** Diagnosis only. Deliberately not used to drive anything. */
  table_status?: string;
}

export type FloorPayload = {
  tables: FloorTable[];
  /** The server's clock at response time; lets the grid tick between refreshes. */
  serverTime: string | null;
};

/**
 * The floor grid — EVERY active table, open and free.
 *
 * `?view=floor` is REQUIRED. Without it this route returns the legacy occupied-tables-only shape
 * that getTablesWithMeta consumes, which has no `state`, no `owner` and no `seconds_open`, and the
 * grid would render every table as free.
 */
export async function getFloorTables(token: string): Promise<FloorPayload> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tables?view=floor`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfTerminalSessionExpired(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as {
    tables?: FloorTable[];
    server_time?: string;
  };

  return {
    tables: data.tables ?? [],
    serverTime: typeof data.server_time === 'string' ? data.server_time : null,
  };
}

export interface OpenTableResult {
  /**
   * TRUE IS A SUCCESS, NOT AN ERROR. It means the table already had a live tab and the device is
   * being handed it — two waiters tapping the same table at once, or a slightly stale grid.
   * Proceed into the round screen exactly as if the tab had just been created.
   */
  already_open: boolean;
  /**
   * TRUE means the table was ALREADY OPEN and this device adopted the live tab rather than
   * creating one. Distinct from `already_open` only in name — kept as the field the screens read
   * so the adoption notice cannot be confused with an error branch.
   */
  adopted?: boolean;
  /**
   * Non-null when this open TOOK THE TABLE FROM ANOTHER WAITER. The person doing it must be told:
   * a silent reassignment leaves two people believing they are serving the same table, and the
   * one who lost it finds out when a round they did not place appears on their section.
   */
  handed_over_from?: {user_id: string; name: string} | null;
  table: {id: string; table_number: number};
  tab: {
    id: string;
    status: string;
    total: number;
    opened_at?: string;
    opened_by_user_id?: string;
  };
  owner: FloorTableOwner | null;
}

/**
 * Spends the single-use 90-second authorization token on opening a table.
 *
 * Call this IMMEDIATELY after authorizeAction. The token is single-use and expires in 90 seconds;
 * caching it, reusing it, or fetching it in advance all end in a 403 AUTHORIZATION_* that has
 * already burned the waiter's PIN entry.
 *
 * A 404 or 409 here has NOT burned it — the table is validated before the token is consumed — so
 * those two re-render the grid rather than re-prompting for a PIN.
 */
export async function openServiceTable(
  params: {tableId: string; userId: string; authorizationTokenId: string},
  token: string,
): Promise<OpenTableResult> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tables/${encodeURIComponent(
      params.tableId,
    )}/open`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        user_id: params.userId,
        authorization_token_id: params.authorizationTokenId,
      }),
    },
    token,
  );

  throwIfTerminalSessionExpired(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as OpenTableResult;
  return {...data, already_open: Boolean(data.already_open)};
}

export interface StationCounts {
  kitchen: number;
  bar: number;
  /**
   * Items whose category had no usable routing. NOT defaulted to the kitchen, on purpose. The
   * brief requires this to be shown when it is above zero: it is a menu problem, and the waiter is
   * the first person in a position to notice.
   *
   * Shape and meaning are unchanged by the one-line-per-item schema change — these are still how
   * many lines each screen will show.
   */
  unrouted: number;
}

export interface RoundResult {
  success: boolean;
  order_id: string;
  order_number: number;
  tab_id: string;
  lines_written: boolean;
  /**
   * EXACTLY THE NUMBER OF ITEMS SENT. It was briefed as able to exceed that — a `both` item used
   * to fan out into a kitchen row and a bar row — and it no longer can: one line now carries the
   * frozen `route_to` plus separate `kitchen_state` and `bar_state`, so each station still bumps
   * independently while a cancellation cancels one thing and the bill counts it once.
   *
   * Nothing on the device is built around the old fan-out, deliberately. If this ever comes back
   * above the item count, that is a server change to chase, not a display quirk to absorb.
   */
  line_count: number;
  station_counts: StationCounts;
}

/**
 * 502. The round IS ON THE TAB but the kitchen and bar were never told.
 *
 * Its own class because it must never be handled by a generic error branch: the customer will be
 * billed for food nobody has been told to cook. Do not retry it, do not collapse it into "failed" —
 * a retry double-bills, and "failed" is a lie in the direction that loses money. The order number
 * stays on screen so a manager can be told which order.
 */
export class RoundLinesNotWrittenError extends Error {
  orderId: string | null;
  orderNumber: number | null;

  constructor(
    message: string,
    orderId: string | null,
    orderNumber: number | null,
  ) {
    super(message);
    this.name = 'RoundLinesNotWrittenError';
    this.orderId = orderId;
    this.orderNumber = orderNumber;
  }
}

/** 409 TAB_NOT_OPEN. The tab was settled or closed while the round was being built. */
export class TabNotOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TabNotOpenError';
  }
}

/** 409 OUT_OF_STOCK. Carries EVERY refused item so the basket can flag them all at once. */
export class RoundOutOfStockError extends Error {
  outOfStock: {item: string; ingredient?: string}[];

  constructor(
    message: string,
    outOfStock: {item: string; ingredient?: string}[],
  ) {
    super(message);
    this.name = 'RoundOutOfStockError';
    this.outOfStock = outOfStock;
  }
}

/**
 * The exact wording the brief requires when the server sends no message of its own with a
 * LINES_NOT_WRITTEN 502. Not a paraphrase, and not a generic failure string.
 */
export const LINES_NOT_WRITTEN_MESSAGE =
  'The round was recorded on the tab but the kitchen and bar were not notified. ' +
  'Tell a manager before serving this table.';

/**
 * Commits a round to an open tab.
 *
 * TAKES NO user_id, BY DESIGN. Attribution is read server-side from the tab's
 * `opened_by_user_id` and cannot be overridden by the request, which is precisely why a device
 * cannot credit a round to somebody else. Do not invent a PIN prompt here.
 *
 * `subtotal` and `total` are ADVISORY — the server re-prices from the catalog and ignores them.
 * That is the anti-tampering control on the terminal path. Show the waiter the computed figure,
 * but expect the authoritative one to come from the tab.
 *
 * The error bodies here carry fields (`order_id`, `order_number`, `outOfStock`) that
 * parseApiError's whitelist drops, so the body is read once by hand instead.
 */
export async function sendRound(
  params: {
    tabId: string;
    items: {
      menuItemId: string;
      name: string;
      quantity: number;
      note?: string;
    }[];
    subtotal: number;
    total: number;
    orderInstructions?: string;
    /**
     * MANDATORY. The route rejects a request without the `x-idempotency-key` header with
     * 400 IDEMPOTENCY_KEY_REQUIRED — it is no longer best-effort, because on the existing POS
     * path 0 of 1,545 orders carried one and every failed retry there stranded a duplicate order.
     *
     * ONE value per round attempt, REUSED across every retry of that same round. A fresh uuid on
     * retry defeats the entire mechanism. A repeat carrying an already-used key returns the
     * ORIGINAL order — same order_id, same order_number — with 200, and that is a SUCCESS: do not
     * create a second round and do not show a failure for it.
     */
    idempotencyKey: string;
  },
  token: string,
): Promise<RoundResult> {
  // Refused here rather than on the wire. An empty key would come back as
  // 400 IDEMPOTENCY_KEY_REQUIRED, and a caller that reached this line without one has a bug that
  // a server round-trip would only disguise.
  if (!params.idempotencyKey) {
    throw new Error('sendRound called without an idempotency key');
  }

  const body: Record<string, unknown> = {
    tab_id: params.tabId,
    items: params.items,
    subtotal: params.subtotal,
    total: params.total,
  };
  const instructions = params.orderInstructions?.trim();
  if (instructions) {
    body.order_instructions = instructions;
  }

  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/rounds`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': params.idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    token,
  );

  throwIfTerminalSessionExpired(response);

  if (response.ok) {
    const data = (await response.json()) as RoundResult;
    return {
      ...data,
      lines_written: data.lines_written !== false,
      line_count: Number(data.line_count ?? 0),
      station_counts: {
        kitchen: Number(data.station_counts?.kitchen ?? 0),
        bar: Number(data.station_counts?.bar ?? 0),
        unrouted: Number(data.station_counts?.unrouted ?? 0),
      },
    };
  }

  // Read once — a Response body cannot be consumed twice, and three of these branches need
  // fields that ApiRequestError does not carry.
  let raw: Record<string, unknown> = {};
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — the status-only fallbacks below still apply.
  }

  const code = typeof raw.code === 'string' ? raw.code : undefined;
  const serverMessage =
    typeof raw.error === 'string' && raw.error ? raw.error : null;

  if (code === 'LINES_NOT_WRITTEN') {
    throw new RoundLinesNotWrittenError(
      serverMessage ?? LINES_NOT_WRITTEN_MESSAGE,
      typeof raw.order_id === 'string' ? raw.order_id : null,
      finiteOrNull(raw.order_number),
    );
  }

  if (code === 'TAB_NOT_OPEN') {
    throw new TabNotOpenError(
      serverMessage ?? 'This table was closed while the round was being built.',
    );
  }

  if (code === 'OUT_OF_STOCK') {
    const rows = Array.isArray(raw.outOfStock) ? raw.outOfStock : [];
    throw new RoundOutOfStockError(
      serverMessage ?? 'Some items are out of stock.',
      rows
        .filter(
          (row): row is Record<string, unknown> =>
            !!row && typeof row === 'object',
        )
        .map(row => ({
          item: String(row.item ?? ''),
          ingredient:
            row.ingredient != null ? String(row.ingredient) : undefined,
        })),
    );
  }

  throw new ApiRequestError(
    serverMessage ?? `Request failed (${response.status})`,
    response.status,
    {code},
  );
}

/**
 * Everything on ONE TAB: the bill, every order, every fulfilment line, and the server's own
 * verdict on which lines are ready.
 *
 * THIS IS THE ONLY SOURCE OF READINESS ON THE DEVICE. It exists because the station routes cannot
 * answer the waiter's question: `/api/station/lines` is scoped by restaurant and returns only
 * OUTSTANDING work, so a line that has gone out disappears from it entirely — and "has the starter
 * gone out yet" is answered by a line that is DONE. Joining the legacy tables payload against the
 * station feed to infer the difference was considered and rejected: it reports "ready" for
 * anything the station call happens not to return, which is a lie in the direction that sends a
 * waiter to collect food that is not there.
 *
 * `is_ready` and `all_ready` are computed server-side through the same definition the kitchen and
 * bar screens use. Do not recompute them here or in a screen.
 *
 * 401 only, like every other service route — see the block comment above getFloorTables. A 403
 * here is a terminal missing `orders:read`, which no token refresh can fix.
 */
/**
 * POST /api/terminal/tabs/{tabId}/amend -- change or remove a line before the kitchen starts it.
 *
 * Contract read off app/api/terminal/tabs/[tabId]/amend/route.ts and migration
 * 20260829150000_amend_order_lines_function.sql, not inferred. See lib/amendTabLines.ts for the
 * model and for why the refusal strings are the SQL function's own literals.
 *
 * Auth is the terminal token plus orders:update, and the venue must have station_screens_enabled.
 * THERE IS NO PIN on this route -- do not add a PIN prompt for a route that consumes none, or the
 * waiter types a code that authorises nothing.
 *
 * REFUSALS ARE NOT ERRORS. A 200 carrying refused: [...] is the NORMAL outcome when the kitchen
 * started a line while the waiter was still typing. The screen renders it as a fact about those
 * lines, not as a failed request. Everything that IS an error throws a coded ApiRequestError and
 * none of them are fixed by re-sending the same body: STATION_SCREENS_DISABLED (403),
 * INVALID_LINE_ID / INVALID_QUANTITY (400), AMEND_FAILED (502 -- the transaction rolled back and
 * NOTHING was voided).
 *
 * Do not retry the refused lines. They were refused because the kitchen already has them.
 */
export async function amendTabLines(
  tabId: string,
  amendments: LineAmendment[],
  token: string,
): Promise<AmendResult> {
  if (amendments.length === 0) {
    throw new Error('amendTabLines called with no amendments');
  }

  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tabs/${encodeURIComponent(tabId)}/amend`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({amendments}),
    },
    token,
  );

  throwIfTerminalSessionExpired(response);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const data = (await response.json()) as Partial<AmendResult>;

  return {
    order_id: data.order_id ?? null,
    order_number: data.order_number ?? null,
    applied: Array.isArray(data.applied) ? data.applied : [],
    refused: Array.isArray(data.refused) ? data.refused : [],
  };
}

export async function getTabLines(
  tabId: string,
  token: string,
): Promise<TabLinesPayload> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/tabs/${encodeURIComponent(tabId)}/lines`,
    {headers: {'Content-Type': 'application/json'}},
    token,
  );

  throwIfTerminalSessionExpired(response);

  if (!response.ok) {
    // 403 missing permission, 404 tab not found (also another venue's tab — the route is
    // restaurant-scoped), 400 malformed uuid. All three are coded ApiRequestErrors the screen
    // branches on; none of them is retryable by refreshing anything.
    throw await parseApiError(response);
  }

  const data = (await response.json()) as Partial<TabLinesPayload>;

  const orders = Array.isArray(data.orders) ? data.orders : [];

  return {
    tab: {
      id: String(data.tab?.id ?? tabId),
      table_number: Number(data.tab?.table_number ?? 0),
      status: String(data.tab?.status ?? ''),
      total: Number(data.tab?.total ?? 0),
      opened_at: data.tab?.opened_at ?? null,
      opened_by_user_id: data.tab?.opened_by_user_id ?? null,
    },
    orders: orders.map(order => ({
      order_id: String(order.order_id ?? ''),
      order_number: Number(order.order_number ?? 0),
      order_instructions: order.order_instructions ?? null,
      order_total: Number(order.order_total ?? 0),
      placed_at: String(order.placed_at ?? ''),
      seconds_since_placed: finiteOrNull(order.seconds_since_placed),
      lines: (Array.isArray(order.lines) ? order.lines : []).map(line => ({
        id: String(line.id ?? ''),
        name_snapshot: String(line.name_snapshot ?? ''),
        quantity: Number(line.quantity ?? 0),
        line_note: line.line_note ?? null,
        route_to: line.route_to ?? null,
        kitchen_state: line.kitchen_state ?? null,
        bar_state: line.bar_state ?? null,
        // Defaulted FALSE, never true. An unreadable flag must not assert that food is ready.
        is_ready: line.is_ready === true,
        is_voided: line.is_voided === true,
        unrouted: line.unrouted === true,
      })),
    })),
    summary: {
      total_lines: Number(data.summary?.total_lines ?? 0),
      outstanding: Number(data.summary?.outstanding ?? 0),
      ready: Number(data.summary?.ready ?? 0),
      voided: Number(data.summary?.voided ?? 0),
    },
    // Same reasoning as is_ready: absent is never "everything is ready".
    all_ready: data.all_ready === true,
    has_lines: data.has_lines === true,
    server_time: typeof data.server_time === 'string' ? data.server_time : null,
  };
}

// ─── Menu availability (mark a dish unavailable from the terminal) ─────────────────────────
//
// POST /api/terminal/menu-items/{itemId}/availability
//
// ONE ROUTE, BOTH DIRECTIONS. `available: false` puts the item into `hidden` — gone from every
// customer menu at the venue, QR and terminal alike. `available: true` puts it back. Both require
// the same single-use PIN authorization token, from POST /api/terminal/authorize with purpose
// `menu_availability`.
//
// THIS ROUTE USES throwIfTerminalSessionExpired (401 ONLY), NOT throwIfUnauthorized, AND THAT IS
// THE WHOLE POINT — the same reasoning as the waiter-led service routes above.
//
// A 403 here means THE PIN DID NOT AUTHORISE IT. It is a business answer about a person, and no
// amount of terminal-token refreshing can change it. throwIfUnauthorized would collapse it into
// TerminalAuthError, and the layer above would then do what it does for an expired session:
// refresh the device JWT and try again — against a problem the new JWT cannot fix. That loop
// cannot succeed, cannot terminate on its own, and is the failure class that produced #327.
//
// terminalFetch's own refresh-and-retry is likewise 401-only, so a 403 makes exactly ONE request.
// That is asserted, not assumed: see __tests__/menuAvailabilityContract.test.ts.

/** The item as the server reports it AFTER the write. `status` is 'available' or 'hidden'. */
export interface MenuAvailabilityItem {
  id: string;
  name: string;
  status: string;
}

/**
 * The outcome of an availability change.
 *
 * A REFUSAL IS NOT AN ERROR AND IS NOT THROWN. The server answers `already_in_that_state` with
 * HTTP 200, because during service it is a NORMAL outcome: two waiters noticed the same empty
 * tray, and the second one is being told the first already did it. `item_not_found` (404) and
 * `authorization_failed` (403) are the same shape for the same reason — each carries a `message`
 * the screen renders verbatim, and none of them is a condition the device should retry, log as a
 * crash, or dress up in its own wording.
 *
 * What DOES throw: a 401 (TerminalAuthError, the session really is gone) and any response that is
 * neither a success nor a recognisable refusal (ApiRequestError).
 */
export type MenuAvailabilityOutcome =
  | {ok: true; item: MenuAvailabilityItem; hidden: boolean}
  | {ok: false; refusal: string; message: string};

/**
 * Spends the single-use 90-second authorization token on a menu availability change.
 *
 * Call this IMMEDIATELY after authorizeAction, exactly as openServiceTable is called. The token is
 * single-use and expires in 90 seconds; caching it, reusing it, or fetching it ahead of the PIN
 * all end in a 403 that has already burned the waiter's PIN entry.
 */
export async function setMenuItemAvailability(
  params: {
    itemId: string;
    userId: string;
    authorizationTokenId: string;
    available: boolean;
  },
  token: string,
): Promise<MenuAvailabilityOutcome> {
  const response = await terminalFetch(
    `${FLASHTAP_API_URL}/api/terminal/menu-items/${encodeURIComponent(
      params.itemId,
    )}/availability`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        user_id: params.userId,
        authorization_token_id: params.authorizationTokenId,
        available: params.available,
      }),
    },
    token,
  );

  // 401 ONLY. See the block comment above for why a 403 must not come through here.
  throwIfTerminalSessionExpired(response);

  // The body is read ONCE, by hand, and every branch below reads the parsed object rather than the
  // response. parseApiError would consume the stream, and a refusal carries `message` where every
  // older route carries `error` — so the shared parser would drop the one field that must be shown.
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }

  const message = typeof body?.message === 'string' ? body.message : '';

  // Checked BEFORE response.ok, because a refusal arrives on 200 and on 403/404 alike and must be
  // handled identically in all three cases.
  if (body && body.ok === false && typeof body.refusal === 'string') {
    return {ok: false, refusal: body.refusal, message};
  }

  if (!response.ok) {
    const fallback =
      typeof body?.error === 'string'
        ? body.error
        : `Request failed (${response.status})`;
    throw new ApiRequestError(message || fallback, response.status, {
      code: typeof body?.code === 'string' ? body.code : undefined,
    });
  }

  const item = (body?.item ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    item: {
      id: typeof item.id === 'string' ? item.id : params.itemId,
      name: typeof item.name === 'string' ? item.name : '',
      status: typeof item.status === 'string' ? item.status : '',
    },
    // Defaulted FALSE only when the field is absent, and the screen does not rely on it alone —
    // it reconciles against `item.status` too. Same reasoning as is_ready above: an unreadable
    // flag must never assert the more destructive of the two states.
    hidden: body?.hidden === true,
  };
}
