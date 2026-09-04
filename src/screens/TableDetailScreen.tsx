import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import LoadingButton from '../components/LoadingButton';
import PaymentStatusBadge from '../components/PaymentStatusBadge';
import StrandedRequestPrompt from '../components/StrandedRequestPrompt';
import {
  ApiRequestError,
  AuthorizedUser,
  allocateLine,
  authorizeTerminalAction,
  getAuthorizedUsers,
  closeTable,
  completePaymentReliably,
  type PendingOrderRequest,
  getTablesWithMeta,
  getTabLines,
  getTerminalInfo,
  recordSaleEvent,
  resetTabPin,
  settleAllocations,
  settleTab,
} from '../lib/api';
import QRCode from 'react-native-qrcode-svg';
import {
  declinedFailureReference,
  processPaymentIntent,
  resolveAmbiguousPaymentWithFinatic,
  unconfirmedFailureReference,
} from '../lib/payment';
import {
  isClaimablePaymentStatus,
  selectClaimableOrdersForSettle,
} from '../lib/paymentIntegrity';
import {
  canConfirmPin,
  preselectFor,
  showsSkipOnly,
} from '../lib/cashAttributionPicker';
import {selectCashSettleableOrders} from '../lib/cashSettlement';
import {
  ALLOCATION_PAYER_AT_TABLE,
  canTakePaymentByItem,
  formatCents,
  outstandingTotalCents,
  payableLines,
  planFor,
  selectionTotalCents,
  type PayableLine,
  type SettlementPlan,
} from '../lib/takePaymentLines';
import {
  TAKE_PAYMENT_ALL_PAID,
  TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER,
  TAKE_PAYMENT_LINE_NO_PRICE,
  TAKE_PAYMENT_LINE_NOT_CLAIMABLE,
  TAKE_PAYMENT_LINE_PAID,
  TAKE_PAYMENT_LINE_PART_PAID,
  TAKE_PAYMENT_NOT_ITEMISED,
  TAKE_PAYMENT_ORDER_HEADING,
  TAKE_PAYMENT_SELECTION,
  TAKE_PAYMENT_SELECTION_ONE,
} from '../constants/takePaymentCopy';
import type {TabLinesPayload} from '../lib/tabLines';
import {canResetTabPin} from '../lib/terminalPermissions';
import {
  TAB_RECOVERY_ACTION_LABEL,
  TAB_RECOVERY_DONE_LABEL,
  TAB_RECOVERY_EXPIRED,
  TAB_RECOVERY_FAILED,
  TAB_RECOVERY_IN_PROGRESS,
  TAB_RECOVERY_INSTRUCTION,
  TAB_RECOVERY_NEW_CODE_LABEL,
  TAB_RECOVERY_NOT_PERMITTED,
  TAB_RECOVERY_TITLE,
  tabRecoveryExpiresIn,
} from '../constants/tabRecoveryCopy';
import {
  TAB_RECOVERY_TTL_MS,
  isRecoveryExpired,
  recoveryLifetimeMs,
  recoverySecondsRemaining,
} from '../lib/tabRecoveryExpiry';
import {classifyFailureReport} from '../lib/paymentReportOutcome';
import {
  SETTLE_ORDER_ALREADY_PAID,
  UNCONFIRMED_NOT_REPORTED,
  UNCONFIRMED_SETTLE_INSTRUCTION,
} from '../constants/paymentCopy';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';
import {TabOrder, TableWithTab} from '../types';

type Props = NativeStackScreenProps<MainStackParamList, 'TableDetail'>;

function formatNad(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `NAD ${safe.toFixed(2)}`;
}

function isPaid(order: TabOrder): boolean {
  return order.payment_status === 'paid';
}

/**
 * Mirrors the backend's isClaimablePaymentStatus (lib/payments/payment-integrity.ts):
 * only 'unpaid'/'pending' orders may be selected, summed, or charged. A cancelled
 * order's payment_status is 'cancelled', not 'unpaid' — the old `!isPaid` check
 * couldn't tell the difference and would let a cancelled order's total reach the
 * card reader.
 */
function isClaimable(order: TabOrder): boolean {
  return isClaimablePaymentStatus(order.payment_status);
}

export default function TableDetailScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const [table, setTable] = useState<TableWithTab>(route.params.table);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /**
   * TAKE PAYMENT BY ITEM (Ship 1b).
   *
   * The screen lists THINGS now, not guests. `linesPayload` is the server's line-by-line view of
   * this tab and `selectedLineIds` is what the waiter has ticked. `selectedIds` above stays what
   * it always was -- an ORDER selection -- and in item mode it is not used for the item list at
   * all; the plan decides which orders a payment covers, so nothing reads a selection twice.
   *
   * Null means not loaded or not readable. A tab the server cannot itemise falls back to the
   * order list this screen has always shown, rather than presenting an empty bill.
   */
  const [linesPayload, setLinesPayload] = useState<TabLinesPayload | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  /**
   * What the pending cash prompt is about to collect.
   *
   * Captured when the prompt OPENS, not read back off the selection when it closes. The staff-PIN
   * dialog is a second screen over a live list: a refresh behind it can change what is selected,
   * and a cash payment must collect the amount the waiter agreed to, not whatever is ticked by the
   * time the PIN lands.
   */
  const [pendingCash, setPendingCash] = useState<SettlementPlan | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [closingTable, setClosingTable] = useState(false);
  /** #120 residual: the rows the close route reported as blocking, and its own message. */
  const [strandedRequests, setStrandedRequests] = useState<PendingOrderRequest[]>([]);
  const [strandedMessage, setStrandedMessage] = useState('');
  const [settling, setSettling] = useState(false);
  const [cashSettling, setCashSettling] = useState(false);
  /**
   * ONE flag for BOTH settle paths, deliberately shared.
   *
   * Card and cash are two ways to collect the same money. A guard per path would still permit
   * "tap Settle, then tap Take Cash" while the card attempt is in flight — which is the exact
   * double-collection the server refuses with CARD_PAYMENT_IN_FLIGHT, and the device should not
   * be sending it in the first place. See the block comment in runSettle.
   */
  const settleInFlight = useRef(false);
  /**
   * Server's in-flight window, from /api/terminal/tables. Never hardcoded — the countdown
   * must match the server that will actually accept or reject the settle.
   */
  const [cardTimeoutSeconds, setCardTimeoutSeconds] = useState<number | null>(
    null,
  );
  /** Seconds remaining on a CARD_PAYMENT_IN_FLIGHT refusal; null when not blocked. */
  const [cashBlockedFor, setCashBlockedFor] = useState<number | null>(null);
  const [pinPromptVisible, setPinPromptVisible] = useState(false);
  const [pinValue, setPinValue] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  // Staff picker. The user_id is never shown or typed — staff tap their name and the
  // uuid is carried through to /authorize and then to settle.
  const [staffList, setStaffList] = useState<AuthorizedUser[] | null>(null);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffLoadFailed, setStaffLoadFailed] = useState(false);
  const [pinStaff, setPinStaff] = useState<AuthorizedUser | null>(null);
  /**
   * #265 — PIN recovery. `recoveryUrl` is the only thing that comes back and it is rendered as a
   * QR for the CUSTOMER to scan; there is no PIN in this flow for staff to see, by design.
   *
   * `terminalPermissions` starts undefined, which canResetTabPin reads as "cannot tell" and
   * therefore shows the control — see lib/terminalPermissions for why that direction is the safe
   * one when the server is the real gate.
   */
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryUrl, setRecoveryUrl] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [terminalPermissions, setTerminalPermissions] =
    useState<unknown>(undefined);
  /**
   * #265 requirement 4 — a dead QR must leave the screen. "A dead QR left on screen is worse than
   * no QR": the customer scans it, is refused, and asks staff again.
   *
   * The code's life is held as an ISSUED INSTANT plus a DURATION, both on the device's own clock,
   * rather than as the server's absolute `expiresAt`. That is what makes terminal clock skew cancel
   * instead of landing on the customer — see lib/tabRecoveryExpiry.
   */
  const [recoveryIssuedAt, setRecoveryIssuedAt] = useState<number | null>(null);
  const [recoveryLifetime, setRecoveryLifetime] =
    useState<number>(TAB_RECOVERY_TTL_MS);
  const [recoveryNow, setRecoveryNow] = useState<number>(() => Date.now());

  const tab = table.tab;

  /**
   * #265 requirement 4 — derived, never stored, so the expired state cannot go stale behind a
   * missed setState. Both read the same clock the lifetime was measured against.
   */
  const recoveryExpired =
    recoveryIssuedAt != null &&
    isRecoveryExpired(recoveryIssuedAt, recoveryLifetime, recoveryNow);
  const recoverySecondsLeft =
    recoveryIssuedAt == null
      ? 0
      : recoverySecondsRemaining(
          recoveryIssuedAt,
          recoveryLifetime,
          recoveryNow,
        );
  const orders = useMemo(() => tab?.orders ?? [], [tab?.orders]);

  // Selectable/settleable orders — claimable only. A cancelled order is not
  // "paid" either, so `!isPaid` alone would wrongly include it here.
  const unpaidOrders = useMemo(
    () => orders.filter(order => isClaimable(order)),
    [orders],
  );

  const selectedOrders = useMemo(
    () => orders.filter(order => selectedIds.has(order.id)),
    [orders, selectedIds],
  );

  const selectedTotal = useMemo(
    () => selectedOrders.reduce((sum, order) => sum + order.total, 0),
    [selectedOrders],
  );

  // ---- Take Payment by item -------------------------------------------------------------
  /** Every line a waiter could be looking at, with its own money and its own refusal. */
  const payable = useMemo(
    () => payableLines(linesPayload, orders),
    [linesPayload, orders],
  );
  /** Whether this tab can be paid item by item at all. False falls back to the order list. */
  const byItem = useMemo(
    () => canTakePaymentByItem(linesPayload) && payable.length > 0,
    [linesPayload, payable.length],
  );
  /**
   * WHICH MONEY PATH THE TICKED ITEMS TAKE. Computed in lib/takePaymentLines and nowhere else --
   * a selection covering whole orders goes down the proven whole-order route with its card
   * fallbacks; only a genuine part-order payment uses the item ledger.
   */
  const plan = useMemo(
    () => (byItem ? planFor(payable, selectedLineIds) : ({kind: 'nothing'} as SettlementPlan)),
    [byItem, payable, selectedLineIds],
  );
  const selectedItemCents = useMemo(
    () => selectionTotalCents(payable, selectedLineIds),
    [payable, selectedLineIds],
  );
  /** Rows for the item list: an order heading followed by its lines. */
  const itemRows = useMemo(() => {
    const rows: Array<
      {kind: 'heading'; key: string; orderNumber: number} | {kind: 'line'; key: string; line: PayableLine}
    > = [];
    let lastOrderId: string | null = null;
    for (const line of payable) {
      if (line.orderId !== lastOrderId) {
        rows.push({kind: 'heading', key: `h-${line.orderId}`, orderNumber: line.orderNumber});
        lastOrderId = line.orderId;
      }
      rows.push({kind: 'line', key: line.id, line});
    }
    return rows;
  }, [payable]);

  // Cash settleability comes from the SERVER (can_settle_cash), never re-derived here.
  // The server owns the settleable-status sets; a second definition on the client is
  // exactly how the two drift apart. Undefined (older server) is treated as "no".
  const cashSettleableOrders = useMemo(
    () => orders.filter(order => order.can_settle_cash === true),
    [orders],
  );

  const selectedCashOrders = useMemo(
    () => selectedOrders.filter(order => order.can_settle_cash === true),
    [selectedOrders],
  );

  // A card payment live on the reader for anything currently selected.
  const selectedHasCardInFlight = useMemo(
    () => selectedOrders.some(order => order.card_payment_in_flight === true),
    [selectedOrders],
  );

  // Tick the CARD_PAYMENT_IN_FLIGHT countdown down to zero, then clear it so the
  // cash button becomes available again without the staff member doing anything.
  useEffect(() => {
    if (cashBlockedFor == null) {
      return;
    }
    if (cashBlockedFor <= 0) {
      setCashBlockedFor(null);
      return;
    }
    const timer = setTimeout(() => {
      setCashBlockedFor(current => (current == null ? null : current - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [cashBlockedFor]);

  const refreshTable = useCallback(async () => {
    setRefreshing(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const {tables, cardInFlightTimeoutSeconds} = await getTablesWithMeta(token);
      setCardTimeoutSeconds(cardInFlightTimeoutSeconds);
      const updated = tables.find(t => t.id === table.id);
      if (updated) {
        setTable(updated);
        /**
         * The item list, read AFTER the tables so it describes the same tab the totals came from,
         * and only for a table the tables route still returns -- a tab id from the stale copy in
         * state would list items belonging to a session that has ended.
         *
         * Its failure is swallowed to null on purpose: a tab whose lines cannot be read is not a
         * broken screen, it is a tab that must be paid by order, which is what null renders.
         */
        const tabId = updated.tab?.id ?? null;
        setLinesPayload(
          tabId ? await getTabLines(tabId, token).catch(() => null) : null,
        );
      }
    } catch (err) {
      Alert.alert(
        'Error',
        err instanceof Error ? err.message : 'Failed to refresh table',
      );
    } finally {
      setRefreshing(false);
    }
  }, [table.id]);

  // Refetch on every focus — not just mount — so returning here (e.g. from a
  // refund or after backing out to Tables and back) never shows stale
  // payment/refund state. See #29.
  useFocusEffect(
    useCallback(() => {
      refreshTable();
    }, [refreshTable]),
  );

  /**
   * Tick or untick one item. A line that cannot be sold -- paid, unpriced, on a cancelled order --
   * is inert here as well as visually: the refusal is enforced where the money is counted, not
   * only where the checkbox is drawn.
   */
  const toggleLineSelection = (line: PayableLine) => {
    if (!line.selectable) {
      return;
    }
    setSelectedLineIds(prev => {
      const next = new Set(prev);
      if (next.has(line.id)) {
        next.delete(line.id);
      } else {
        next.add(line.id);
      }
      return next;
    });
  };

  const toggleOrderSelection = (order: TabOrder) => {
    if (!isClaimable(order)) {
      return;
    }
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(order.id)) {
        next.delete(order.id);
      } else {
        next.add(order.id);
      }
      return next;
    });
  };

  const handleCloseTable = async () => {
    setClosingTable(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      await closeTable(table.id, token);
      navigation.navigate('MainTabs', {screen: 'Tables'});
    } catch (err) {
      /**
       * #120 residual. This used to answer "Failed to close table. Please close from dashboard."
       * for EVERY failure, including the one case the terminal can actually fix — and the
       * dashboard was the wrong escape hatch anyway, because it closed OVER the pending round
       * instead of releasing it.
       *
       * The 409 names the blocking rows and, per row, whether each is a stranded `accepting` claim
       * (releasable) or a real `waiting_review` round (not). Showing that is the difference
       * between a dead end and an answer.
       */
      if (
        err instanceof ApiRequestError &&
        err.code === 'PENDING_ORDER_REQUESTS' &&
        err.pendingRequests.length > 0
      ) {
        setStrandedRequests(err.pendingRequests);
        setStrandedMessage(err.message);
        return;
      }
      Alert.alert(
        'Error',
        'Failed to close table. Please close from dashboard.',
      );
    } finally {
      setClosingTable(false);
    }
  };

  const runSettle = async (requestedOrderIds: string[]) => {
    /**
     * RE-ENTRANCY GUARD — a synchronous double-tap must not reach the card reader twice.
     *
     * `settling` alone did not carry this. It is React state, so `setSettling(true)` below does
     * not take effect until the next render, and the `disabled` prop on the button is computed
     * from it — meaning two presses dispatched inside the SAME batch both find `settling` false,
     * both find the button enabled, and both call processPaymentIntent. On a physical terminal
     * the two taps are usually separate native events with a render between them, which is why
     * this has not been seen; "usually" is not a property money code should rest on.
     *
     * A ref updates synchronously, so the second entry returns here before anything is charged.
     * It is released in the same `finally` that clears `settling`, so a failed settle re-arms
     * the button exactly as before.
     *
     * This guard is the FIRST of three, not the only one. The second is the button's disabled
     * state; the third is the server's atomic claim, which answers 409 ALREADY_PAID to a second
     * settle of the same orders. Only the third can stop two different devices.
     */
    if (settleInFlight.current) {
      return;
    }

    if (requestedOrderIds.length === 0) {
      return;
    }

    // Defense in depth: selection already excludes non-claimable orders, but
    // never let a cancelled/already-paid/refunded order's total reach the
    // card reader even if stale client state lets one slip through — mirrors
    // the backend's CLAIMABLE_PAYMENT_STATUSES check
    // (lib/payments/payment-integrity.ts). amount and orderIds are derived
    // from the same filtered set so the WiseCashier charge and the settleTab
    // call always agree on exactly what was paid for. See
    // selectClaimableOrdersForSettle's tests for the exact guarantee.
    const {orderIds, amount} = selectClaimableOrdersForSettle(
      orders,
      requestedOrderIds,
    );

    if (amount <= 0 || orderIds.length === 0) {
      Alert.alert('Error', 'Selected orders have no amount to settle.');
      return;
    }

    if (!tab?.id) {
      Alert.alert('Error', 'No active tab found for this table.');
      return;
    }

    settleInFlight.current = true;
    setSettling(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }

      let paymentResult = await processPaymentIntent(
        amount,
        orderIds.join(','),
      );

      // Ambiguous / orphaned device outcomes: ask Finatic before assuming failure
      // (mirrors PaymentScreen's handleProcessPayment).
      if (
        !paymentResult.success &&
        (paymentResult.outcomeKind === 'ambiguous' ||
          paymentResult.outcomeKind === 'orphaned_ambiguous' ||
          paymentResult.orphaned)
      ) {
        paymentResult = await resolveAmbiguousPaymentWithFinatic(
          orderIds[0],
          paymentResult,
        );
      }

      if (!paymentResult.success || !paymentResult.reference) {
        const baseError = paymentResult.error ?? 'Payment was declined';
        const failureReference =
          paymentResult.reference?.trim() ||
          (paymentResult.outcomeKind === 'confirmed_failure' &&
          paymentResult.gatewayResult
            ? declinedFailureReference(paymentResult.gatewayResult)
            : unconfirmedFailureReference());
        // Never leave a silent gap after a card attempt — tell the backend even though
        // this tab-settle attempt is about to fail.
        const completed = await completePaymentReliably(orderIds[0], token, {
          status: 'failed',
          reference: failureReference,
          amount,
          paymentMethod: 'card',
          businessOrderNo: paymentResult.businessOrderNo,
        });
        /**
         * #327 / #326. Same classification as PaymentScreen, and the same two defects fixed:
         * `${baseError} — could not notify the system.` glued a lower-cased fragment onto a
         * sentence that already ended in a full stop (#326), and an outcome the server explicitly
         * could not confirm was thrown as a flat failure (#327).
         *
         * The tab-settle flow reports the failure and stops either way — it does NOT settle the
         * tab, so no money is moved and no order is released by this branch. What changes is what
         * staff are told, which is what decides whether the food goes out.
         */
        const classification = classifyFailureReport(completed);
        if (classification === 'unknown') {
          throw new Error(
            completed
              ? UNCONFIRMED_SETTLE_INSTRUCTION
              : UNCONFIRMED_NOT_REPORTED,
          );
        }
        if (classification === 'settled') {
          // The server verified with Finatic and found the money, so this order is paid even
          // though the settle stopped. Reporting that as a decline is how staff end up taking a
          // second card payment for it.
          throw new Error(SETTLE_ORDER_ALREADY_PAID);
        }
        throw new Error(baseError);
      }

      const settleResult = await settleTab(
        tab.id,
        orderIds,
        amount,
        paymentResult.reference,
        token,
        {
          voucherNo: paymentResult.voucherNo,
          businessOrderNo: paymentResult.businessOrderNo,
        },
      );

      const businessOrderNo = paymentResult.businessOrderNo;
      const transactionId = paymentResult.voucherNo;
      if (businessOrderNo && transactionId) {
        recordSaleEvent(
          {
            orderIds,
            businessOrderNo,
            transactionId,
            amount,
          },
          token,
        ).then(saleRecord => {
          if (!saleRecord.ok) {
            console.warn(
              '[TableDetail] recordSaleEvent failed:',
              saleRecord.error,
            );
          }
        });
      } else {
        console.warn(
          '[TableDetail] Skipping recordSaleEvent — missing businessOrderNo or voucherNo',
          {
            businessOrderNo,
            voucherNo: transactionId,
          },
        );
      }

      setSelectedIds(new Set());
      setTable(prev => ({
        ...prev,
        can_close: settleResult.can_close,
        tab: prev.tab
          ? {
              ...prev.tab,
              // null when the server flagged its own recalculation as untrustworthy —
              // keep the previous figure rather than showing a wrong one.
              unpaid_total: settleResult.new_tab_total ?? prev.tab.unpaid_total,
              orders: prev.tab.orders.map(order =>
                orderIds.includes(order.id)
                  ? {...order, payment_status: 'paid'}
                  : order,
              ),
            }
          : null,
      }));

      await refreshTable();
    } catch (err) {
      Alert.alert(
        'Error',
        err instanceof Error ? err.message : 'Failed to settle tab',
      );
    } finally {
      settleInFlight.current = false;
      setSettling(false);
    }
  };

  /**
   * Take cash for the given orders. No card reader involved and no Finatic call — the
   * server records the settlement, issues the receipt and writes the audit entry.
   *
   * `attribution` is optional by design: the server does not gate on it, so cash can
   * still be taken when nobody enters a PIN, and that settle is recorded as
   * terminal_only rather than being silently attributed to no one.
   */
  /**
   * CASH FOR PART OF AN ORDER, through the item ledger.
   *
   * Two steps, and only the second one moves money: lines nobody has split yet are allocated
   * first, then every allocation in scope is settled in one call. The allocate step writes no
   * settlement -- an interrupted run leaves allocations that are visibly still owed on this very
   * screen, which is recoverable; a settle without them would not be.
   *
   * CASH ONLY, DELIBERATELY. The card reader is driven by the whole-order flow, which owns the
   * push/poll and the four gateway fallbacks. Recording method 'card' here without charging
   * anything would write a card payment nobody took -- so the card button refuses a part-order
   * selection and says how to get the card back. See TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER.
   */
  const runCashSettleAllocations = async (
    target: Extract<SettlementPlan, {kind: 'allocations'}>,
    attribution?: {staffUserId: string; authorizationTokenId: string},
  ) => {
    if (settleInFlight.current) {
      return;
    }
    if (!tab?.id) {
      Alert.alert('Error', 'No active tab found for this table.');
      return;
    }
    settleInFlight.current = true;
    setCashSettling(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }

      const allocationIds = [...target.settle];
      for (const {lineId} of target.allocate) {
        const line = payable.find(row => row.id === lineId);
        if (!line) {
          continue;
        }
        const result = await allocateLine(
          tab.id,
          lineId,
          [
            {
              allocated_to: ALLOCATION_PAYER_AT_TABLE,
              quantity_allocated: line.quantity,
            },
          ],
          token,
        );
        allocationIds.push(...result.allocations.map(a => a.id));
      }

      if (allocationIds.length === 0) {
        Alert.alert('Cannot take cash', 'Nothing on this selection is still owed.');
        return;
      }

      const result = await settleAllocations(
        tab.id,
        {
          allocationIds,
          method: 'cash',
          staffUserId: attribution?.staffUserId ?? null,
          authorizationTokenId: attribution?.authorizationTokenId ?? null,
        },
        token,
      );

      // The SERVER's arithmetic, never the device's running total: `applied` is what it actually
      // took, and a partially refused settle must not report the amount that was asked for.
      const takenCents = result.applied.reduce((sum, a) => sum + a.amount_cents, 0);
      setSelectedLineIds(new Set());
      setCashBlockedFor(null);
      Alert.alert('Cash recorded', `${formatCents(takenCents)} taken in cash.`);
      await refreshTable();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'CARD_PAYMENT_IN_FLIGHT') {
        setCashBlockedFor(
          err.retryAfterSeconds != null && err.retryAfterSeconds > 0
            ? Math.ceil(err.retryAfterSeconds)
            : cardTimeoutSeconds,
        );
      }
      Alert.alert(
        'Could not take cash',
        err instanceof Error ? err.message : 'Please try again.',
      );
      await refreshTable();
    } finally {
      settleInFlight.current = false;
      setCashSettling(false);
    }
  };

  const runCashSettle = async (
    requestedOrderIds: string[],
    attribution?: {staffUserId: string; authorizationTokenId: string},
  ) => {
    // Shares runSettle's guard, and for the reason given where settleInFlight is declared:
    // cash taken while a card attempt is live is a double collection, not a second button.
    if (settleInFlight.current) {
      return;
    }
    // Server-driven: only orders the server says are cash-settleable, and the amount is
    // derived from that same set so the two can never disagree. The rule lives in
    // lib/cashSettlement so the suite named after it tests this and not a copy (#148 sweep).
    const {orderIds, amount} = selectCashSettleableOrders(
      orders,
      requestedOrderIds,
    );

    if (orderIds.length === 0 || amount <= 0) {
      Alert.alert(
        'Cannot take cash',
        'None of the selected orders can be settled in cash right now. Pull to refresh and try again.',
      );
      return;
    }

    if (!tab?.id) {
      Alert.alert('Error', 'No active tab found for this table.');
      return;
    }

    settleInFlight.current = true;
    setCashSettling(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }

      const result = await settleTab(
        tab.id,
        orderIds,
        amount,
        '',
        token,
        {
          staffUserId: attribution?.staffUserId,
          authorizationTokenId: attribution?.authorizationTokenId,
        },
        'cash',
      );

      setSelectedIds(new Set());
      setCashBlockedFor(null);
      setTable(prev => ({
        ...prev,
        can_close: result.can_close,
        tab: prev.tab
          ? {
              ...prev.tab,
              // null means the server could not trust its own recalculation; keep the
              // previous figure rather than displaying a wrong one.
              unpaid_total: result.new_tab_total ?? prev.tab.unpaid_total,
              orders: prev.tab.orders.map(order =>
                orderIds.includes(order.id)
                  ? {
                      ...order,
                      payment_status: 'paid',
                      can_settle_cash: false,
                      can_settle_card: false,
                    }
                  : order,
              ),
            }
          : null,
      }));

      Alert.alert(
        'Cash recorded',
        `${formatNad(amount)} taken in cash.${
          result.staff_user_id ? '' : ' No staff PIN was entered.'
        }`,
      );

      await refreshTable();
    } catch (err) {
      // The refusal that has a next step: start a live countdown so staff can see when
      // cash becomes available rather than being told "no" with no explanation.
      if (
        err instanceof ApiRequestError &&
        err.code === 'CARD_PAYMENT_IN_FLIGHT'
      ) {
        setCashBlockedFor(
          err.retryAfterSeconds != null && err.retryAfterSeconds > 0
            ? Math.ceil(err.retryAfterSeconds)
            : cardTimeoutSeconds,
        );
      }
      Alert.alert(
        'Cannot take cash',
        err instanceof Error ? err.message : 'Failed to record cash payment',
      );
      await refreshTable();
    } finally {
      settleInFlight.current = false;
      setCashSettling(false);
    }
  };

  /**
   * Load the staff who can authorize a cash settlement here. Fetched when the modal opens
   * rather than on screen mount: the list is small and staff change during a shift.
   *
   * A failure is NOT fatal. Attribution is optional server-side, so a list that will not
   * load must never make cash untakeable — it falls back to the Skip path.
   */
  /**
   * #265 requirement 4 — tick the countdown while a live code is on screen, and stop the moment it
   * expires. Runs only while the sheet is open and a code is showing, so a backgrounded tab detail
   * is not holding a 1s timer for no reason.
   */
  useEffect(() => {
    if (!recoveryVisible || recoveryIssuedAt == null || !recoveryUrl) {
      return;
    }
    if (isRecoveryExpired(recoveryIssuedAt, recoveryLifetime, recoveryNow)) {
      // Already dead — the render has swapped to the expired state, so nothing left to tick.
      return;
    }
    const timer = setTimeout(() => setRecoveryNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [
    recoveryVisible,
    recoveryIssuedAt,
    recoveryLifetime,
    recoveryNow,
    recoveryUrl,
  ]);

  /**
   * #265 — load this terminal's permissions so the recovery control can be hidden where it would
   * only fail. Best effort: a failure leaves `terminalPermissions` undefined, which shows the
   * control and lets the server refuse, which is the deliberate direction (see
   * lib/terminalPermissions). Never blocks the screen.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getTerminalToken();
        if (!token) {
          return;
        }
        const info = await getTerminalInfo(token);
        if (!cancelled) {
          setTerminalPermissions(info.permissions);
        }
      } catch {
        // Leave undefined — "cannot tell", so the control stays visible.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * #265 — staff-initiated PIN recovery for a customer who cannot get back onto their tab.
   *
   * STAFF NEVER SEE A PIN. This mints a single-use token with a 15-minute TTL and returns a
   * recovery URL; the NEW pin is minted when the customer redeems it and is returned only to their
   * device. `reset-pin` never touches `tab_pin`, so there is nothing here to leak — ruling Q1:A.
   *
   * It is also the only exit from #236: a tab with `pin_required` set and `tab_pin` NULL refuses
   * every join with TAB_PIN_UNAVAILABLE, and the redemption branch writes `tab_pin` unconditionally
   * and before the policy check, so this flow rescues a tab that is otherwise unjoinable forever.
   *
   * The sheet opens IMMEDIATELY, before the request resolves, so the operator sees the spinner
   * rather than a button that appears to do nothing for a second.
   */
  const handleStartTabRecovery = async () => {
    if (!tab || recoveryBusy) {
      return;
    }
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryUrl(null);
    setRecoveryVisible(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const result = await resetTabPin(tab.id, token);
      if (!result.ok || !result.recoveryUrl) {
        // A 200 that carries no URL is a failure, not a success with nothing to show.
        throw new Error('reset-pin returned no recovery url');
      }
      /**
       * Requirement 4. The server's absolute instant is converted to a duration ONCE, here, against
       * the same clock that will later measure elapsed time — so whatever this terminal thinks the
       * time is, the skew cancels. Falls back to the route's 15-minute TTL when the server sends
       * nothing, and is clamped both ways; the reasoning is in lib/tabRecoveryExpiry.
       */
      const issuedAt = Date.now();
      setRecoveryIssuedAt(issuedAt);
      setRecoveryLifetime(recoveryLifetimeMs(result.expiresAt, issuedAt));
      setRecoveryNow(issuedAt);
      setRecoveryUrl(result.recoveryUrl);
    } catch (err) {
      console.warn('[TableDetail] reset-pin failed:', err);
      const forbidden = err instanceof ApiRequestError && err.status === 403;
      setRecoveryError(
        forbidden ? TAB_RECOVERY_NOT_PERMITTED : TAB_RECOVERY_FAILED,
      );
    } finally {
      setRecoveryBusy(false);
    }
  };

  const openPinPrompt = async () => {
    setPinError(null);
    setPinValue('');
    setPinStaff(null);
    setStaffLoadFailed(false);
    setStaffList(null);
    setPinPromptVisible(true);
    setStaffLoading(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const users = await getAuthorizedUsers('cash_settlement', token);
      setStaffList(users);
      // Single eligible person: pre-select so it is one tap to the keypad. The rule lives in
      // lib/cashAttributionPicker so the suite that claims to cover it actually does (#148).
      setPinStaff(preselectFor(users));
    } catch {
      setStaffLoadFailed(true);
      setStaffList([]);
    } finally {
      setStaffLoading(false);
    }
  };

  /**
   * Take cash for whatever the prompt was opened about. THE ONE PLACE that turns a plan into a
   * request, so the choice of money path is made in lib/takePaymentLines and read here, never
   * decided twice.
   */
  const runCashForPlan = async (
    target: SettlementPlan | null,
    attribution?: {staffUserId: string; authorizationTokenId: string},
  ) => {
    if (!target || target.kind === 'nothing') {
      return;
    }
    if (target.kind === 'orders') {
      await runCashSettle(target.orderIds, attribution);
      return;
    }
    await runCashSettleAllocations(target, attribution);
  };

  /** Verify the staff PIN, then take the cash with that person attributed to it. */
  const submitPinAndTakeCash = async () => {
    if (!pinStaff) {
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const {token_id} = await authorizeTerminalAction(
        pinStaff.user_id,
        pinValue.trim(),
        'cash_settlement',
        token,
      );
      const target = pendingCash;
      setPinPromptVisible(false);
      setPinValue('');
      await runCashForPlan(target, {
        staffUserId: pinStaff.user_id,
        authorizationTokenId: token_id,
      });
    } catch (err) {
      setPinError(
        err instanceof Error ? err.message : 'Could not verify that PIN.',
      );
    } finally {
      setPinBusy(false);
    }
  };

  const handleTakeCash = () => {
    /**
     * WHAT THIS PROMPT IS ABOUT, decided once and held. In item mode an empty selection means the
     * whole tab, exactly as it always has at order level; the plan is built from every line that
     * is still owed so the same rule picks the money path either way.
     */
    let target: SettlementPlan;
    if (byItem) {
      const ids =
        selectedLineIds.size > 0
          ? selectedLineIds
          : new Set(payable.filter(line => line.selectable).map(line => line.id));
      target = planFor(payable, ids);
    } else {
      const ids =
        selectedIds.size > 0
          ? Array.from(selectedIds)
          : cashSettleableOrders.map(o => o.id);
      target = ids.length === 0 ? {kind: 'nothing'} : {kind: 'orders', orderIds: ids, totalCents: 0};
    }
    if (target.kind === 'nothing') {
      return;
    }
    if (target.kind === 'orders' && !byItem) {
      setSelectedIds(new Set(target.orderIds));
    }
    setPendingCash(target);
    // Attribution is offered, never forced — Skip still records the settlement.
    Alert.alert(
      'Staff PIN',
      'Enter a staff PIN to record who took this cash, or skip.',
      [
        {text: 'Cancel', style: 'cancel', onPress: () => setPendingCash(null)},
        {text: 'Skip', onPress: () => runCashForPlan(target)},
        {text: 'Enter PIN', onPress: () => openPinPrompt()},
      ],
    );
  };

  /**
   * Cash action. Enabled purely on the server's can_settle_cash for the orders in scope;
   * while a card payment is live the server refuses, so the button shows the remaining
   * wait instead of a bare "no".
   */
  const renderCashButton = (eligibleCount: number) => {
    const blocked = cashBlockedFor != null && cashBlockedFor > 0;
    const disabled =
      cashSettling || settling || eligibleCount === 0 || blocked;

    let label = 'Take Cash';
    if (blocked) {
      label = `Card in progress — ${cashBlockedFor}s`;
    } else if (selectedHasCardInFlight) {
      label = 'Card payment in progress';
    } else if (eligibleCount === 0) {
      label = 'Cash unavailable';
    }

    return (
      <LoadingButton
        style={[styles.cashButton, disabled && styles.buttonDisabled]}
        disabled={disabled}
        loading={cashSettling}
        onPress={handleTakeCash}
        spinnerColor={Colors.white}
        icon={
          <MaterialCommunityIcons
            name="cash-multiple"
            size={20}
            color={Colors.white}
          />
        }>
        <Text style={styles.cashButtonText}>{label}</Text>
      </LoadingButton>
    );
  };

  const handleSettleSelected = () => {
    if (!byItem) {
      runSettle(Array.from(selectedIds));
      return;
    }
    /**
     * CARD ON A PART-ORDER SELECTION IS REFUSED, not quietly recorded. The reader is driven by the
     * whole-order flow; the item ledger does not drive it. See runCashSettleAllocations.
     */
    if (plan.kind === 'allocations') {
      Alert.alert('Take Payment', TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER);
      return;
    }
    if (plan.kind === 'orders') {
      runSettle(plan.orderIds);
    }
  };

  const handleSettleEntireTab = () => {
    const unpaidIds = unpaidOrders.map(o => o.id);
    setSelectedIds(new Set(unpaidIds));
    setSelectedLineIds(new Set());
    runSettle(unpaidIds);
  };

  const handlePaidOrderPress = (order: TabOrder) => {
    if (order.payment_status_derived === 'refunded') {
      return;
    }
    navigation.navigate('RefundAuth', {
      orderId: order.id,
      tableId: table.id,
      tableNumber: table.table_number,
      total: order.total,
    });
  };

  /**
   * ONE ITEM. What a customer at the table is actually paying for.
   *
   * A row that cannot be sold still RENDERS -- greyed, with its reason. Hiding a paid item makes a
   * bill a waiter cannot reconcile against the table in front of them; hiding an unpriced one is
   * how it gets collected for nothing.
   */
  const renderItemRow = (line: PayableLine) => {
    const partPaid = line.settledCents > 0 && !line.isPaid;
    const label =
      line.refusal === 'paid'
        ? TAKE_PAYMENT_LINE_PAID
        : line.refusal === 'no_price'
          ? TAKE_PAYMENT_LINE_NO_PRICE
          : line.refusal === 'order_not_claimable'
            ? TAKE_PAYMENT_LINE_NOT_CLAIMABLE
            : partPaid
              ? TAKE_PAYMENT_LINE_PART_PAID.replace(
                  '{amount}',
                  formatCents(line.outstandingCents),
                )
              : null;
    const selected = selectedLineIds.has(line.id);

    return (
      <Pressable
        key={line.id}
        testID={`take-payment-line-${line.id}`}
        style={[styles.orderRow, !line.selectable && styles.orderRowPaid]}
        disabled={!line.selectable || settling || cashSettling}
        onPress={() => toggleLineSelection(line)}>
        <MaterialCommunityIcons
          name={
            line.selectable && selected ? 'checkbox-marked' : 'checkbox-blank-outline'
          }
          size={24}
          color={line.selectable ? Colors.primary : Colors.textMuted}
        />
        <View style={styles.orderInfo}>
          <Text style={styles.memberName} numberOfLines={1}>
            {line.quantity > 1 ? `${line.quantity}x ` : ''}
            {line.name}
          </Text>
          {line.note ? (
            <Text style={styles.orderMeta} numberOfLines={1}>
              {line.note}
            </Text>
          ) : null}
          {label ? <Text style={styles.orderMeta}>{label}</Text> : null}
        </View>
        <Text style={styles.orderTotal}>
          {line.totalCents == null ? '—' : formatCents(line.outstandingCents || line.totalCents)}
        </Text>
      </Pressable>
    );
  };

  const renderOrderRow = ({item}: {item: TabOrder}) => {
    const paid = isPaid(item);
    const claimable = isClaimable(item);
    // Not paid and not claimable (e.g. cancelled) — must render as inert, not
    // as a selectable unpaid row. Otherwise its total could be selected and
    // charged even though it's excluded from unpaidOrders/runSettle now.
    const nonInteractive = paid || !claimable;
    const fullyRefunded = item.payment_status_derived === 'refunded';
    const selected = selectedIds.has(item.id);
    const itemCount = item.items.length;

    // Cancelled only — a paid order stays pressable (tap to refund) exactly
    // as before; only the "neither paid nor claimable" case is now inert.
    const cancelledOrOther = !paid && !claimable;

    return (
      <Pressable
        style={[styles.orderRow, nonInteractive && styles.orderRowPaid]}
        disabled={settling || fullyRefunded || cancelledOrOther}
        onPress={() => {
          if (paid) {
            handlePaidOrderPress(item);
          } else if (claimable) {
            toggleOrderSelection(item);
          }
        }}>
        <MaterialCommunityIcons
          name={
            nonInteractive
              ? 'checkbox-blank-outline'
              : selected
                ? 'checkbox-marked'
                : 'checkbox-blank-outline'
          }
          size={24}
          color={nonInteractive ? Colors.textMuted : Colors.primary}
        />

        <View style={styles.orderInfo}>
          <View style={styles.orderTopLine}>
            <Text style={styles.memberName}>
              {item.member_name || 'Guest'}
            </Text>
            {paid ? (
              <PaymentStatusBadge status={item.payment_status_derived} />
            ) : null}
          </View>
          <Text style={styles.orderMeta}>
            Order #{item.order_number} · {itemCount}{' '}
            {itemCount === 1 ? 'item' : 'items'}
            {!paid && !claimable ? ' · Cancelled' : ''}
          </Text>
        </View>

        <Text style={styles.orderTotal}>{formatNad(item.total)}</Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable style={styles.headerIcon} onPress={() => navigation.goBack()}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>

        <View style={styles.headerCenter}>
          <Text style={styles.tableTitle}>TABLE {table.table_number}</Text>
          <Text style={styles.unpaidTotal}>
            {formatNad(tab?.unpaid_total ?? 0)}
          </Text>
        </View>

        <View style={styles.headerIcon} />
      </View>

      {/*
        #265 — the missing half. Everything behind this button already existed: the reset route is
        live, and the customer half redeems the token and mints a fresh PIN. Until now the route was
        reachable only by a raw authenticated API call, so a customer who forgot their tab PIN could
        not be helped at all.

        Shown only when there IS a tab (nothing to rejoin otherwise) and this terminal is not known
        to lack orders:update.
      */}
      {tab && canResetTabPin(terminalPermissions) ? (
        <View style={styles.recoveryBar}>
          <Pressable
            style={[
              styles.recoveryButton,
              recoveryBusy && styles.buttonDisabled,
            ]}
            disabled={recoveryBusy || settling}
            onPress={handleStartTabRecovery}>
            <MaterialCommunityIcons
              name="qrcode-scan"
              size={18}
              color={Colors.primary}
            />
            <Text style={styles.recoveryButtonText}>
              {recoveryBusy
                ? TAB_RECOVERY_IN_PROGRESS
                : TAB_RECOVERY_ACTION_LABEL}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {table.can_close ? (
        <View style={styles.closeBar}>
          <Pressable
            style={[styles.closeButton, closingTable && styles.buttonDisabled]}
            disabled={closingTable || settling}
            onPress={handleCloseTable}>
            {closingTable ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.closeButtonText}>Close Table</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {byItem ? (
        /**
         * THE BILL, BY ITEM. Take Payment's interaction is unchanged -- a list, checkboxes, a
         * running total, one button. Only what it lists is different: THINGS, not guests.
         */
        <FlatList
          data={itemRows}
          keyExtractor={row => row.key}
          testID="take-payment-item-list"
          renderItem={({item: row}) =>
            row.kind === 'heading' ? (
              <Text style={styles.itemGroupHeading}>
                {TAKE_PAYMENT_ORDER_HEADING.replace('{number}', String(row.orderNumber))}
              </Text>
            ) : (
              renderItemRow(row.line)
            )
          }
          contentContainerStyle={styles.list}
          refreshing={refreshing}
          onRefresh={refreshTable}
          ListFooterComponent={
            outstandingTotalCents(payable) === 0 ? (
              <Text style={styles.itemNotice}>{TAKE_PAYMENT_ALL_PAID}</Text>
            ) : null
          }
        />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={item => item.id}
          renderItem={renderOrderRow}
          contentContainerStyle={
            orders.length === 0 ? styles.emptyList : styles.list
          }
          refreshing={refreshing}
          onRefresh={refreshTable}
          ListHeaderComponent={
            /**
             * Only when the tab HAS orders but the server cannot itemise them. An empty tab needs
             * no explanation, and saying "not itemised" over nothing reads as a fault.
             */
            orders.length > 0 && linesPayload != null ? (
              <Text style={styles.itemNotice}>{TAKE_PAYMENT_NOT_ITEMISED}</Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No orders on this tab</Text>
            </View>
          }
        />
      )}

      {(byItem ? selectedLineIds.size : selectedIds.size) > 0 ? (
        <View
          style={[
            styles.selectionBar,
            {paddingBottom: insets.bottom + Spacing.sm},
          ]}>
          <Text style={styles.selectionText} testID="take-payment-selection">
            {byItem
              ? (selectedLineIds.size === 1
                  ? TAKE_PAYMENT_SELECTION_ONE
                  : TAKE_PAYMENT_SELECTION.replace('{count}', String(selectedLineIds.size))
                ).replace('{amount}', formatCents(selectedItemCents))
              : `${selectedIds.size} ${
                  selectedIds.size === 1 ? 'order' : 'orders'
                } selected — ${formatNad(selectedTotal)}`}
          </Text>
          <Pressable
            style={[styles.settleButton, settling && styles.buttonDisabled]}
            disabled={settling}
            onPress={handleSettleSelected}>
            {settling ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.settleButtonText}>Settle Selected</Text>
            )}
          </Pressable>
          <LoadingButton
            style={[
              styles.settleEntireOutlineButton,
              (settling || unpaidOrders.length === 0) && styles.buttonDisabled,
            ]}
            disabled={settling || unpaidOrders.length === 0}
            loading={settling}
            onPress={handleSettleEntireTab}
            spinnerColor={Colors.textPrimary}>
            <Text style={styles.settleEntireOutlineText}>Settle Entire Tab</Text>
          </LoadingButton>
          {renderCashButton(
            byItem
              ? payable.filter(line => line.selectable && selectedLineIds.has(line.id)).length
              : selectedCashOrders.length,
          )}
        </View>
      ) : (
        <View
          style={[
            styles.bottomBar,
            {paddingBottom: insets.bottom + Spacing.md},
          ]}>
          <LoadingButton
            style={[
              styles.settleEntireButton,
              (settling || unpaidOrders.length === 0) && styles.buttonDisabled,
            ]}
            disabled={settling || unpaidOrders.length === 0}
            loading={settling}
            onPress={handleSettleEntireTab}
            spinnerColor={Colors.white}>
            <Text style={styles.settleEntireButtonText}>Settle Entire Tab</Text>
          </LoadingButton>
          {renderCashButton(
            byItem
              ? payable.filter(line => line.selectable).length
              : cashSettleableOrders.length,
          )}
        </View>
      )}

      <Modal
        visible={pinPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPinPromptVisible(false)}>
        <View style={styles.pinBackdrop}>
          <View style={styles.pinCard}>
            <Text style={styles.pinTitle}>Staff PIN</Text>
            <Text style={styles.pinHint}>
              Records who took this cash. The payment is recorded either way.
            </Text>

            {staffLoading ? (
              <ActivityIndicator style={styles.pinLoader} color={Colors.primary} />
            ) : showsSkipOnly(staffList) ? (
              // No staff have a PIN, or the list would not load. Either way attribution is
              // impossible right now — say so and keep Skip reachable, because cash must
              // never become untakeable over a list.
              <>
                <Text style={styles.pinEmpty}>
                  {staffLoadFailed
                    ? 'Could not load the staff list. You can still record the cash payment without attribution.'
                    : 'No staff PINs set up for this restaurant. You can still record the cash payment without attribution.'}
                </Text>
                <LoadingButton
                  style={styles.cashButton}
                  disabled={false}
                  loading={false}
                  onPress={() => {
                    const target = pendingCash;
                    setPinPromptVisible(false);
                    runCashForPlan(target);
                  }}
                  spinnerColor={Colors.white}>
                  <Text style={styles.cashButtonText}>
                    Take cash without attribution
                  </Text>
                </LoadingButton>
              </>
            ) : (
              <>
                <Text style={styles.pinSectionLabel}>Who is taking the cash?</Text>
                {(staffList ?? []).map(user => {
                  const selected = pinStaff?.user_id === user.user_id;
                  return (
                    <Pressable
                      key={user.user_id}
                      style={[
                        styles.staffRow,
                        selected && styles.staffRowSelected,
                      ]}
                      onPress={() => {
                        setPinStaff(user);
                        setPinError(null);
                      }}>
                      <MaterialCommunityIcons
                        name={
                          selected
                            ? 'radiobox-marked'
                            : 'radiobox-blank'
                        }
                        size={20}
                        color={selected ? Colors.primary : Colors.textMuted}
                      />
                      <Text style={styles.staffRowText}>{user.name}</Text>
                    </Pressable>
                  );
                })}

                <TextInput
                  style={styles.pinInput}
                  placeholder="4-digit PIN"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={4}
                  value={pinValue}
                  onChangeText={setPinValue}
                  editable={!!pinStaff}
                />
                {pinError ? (
                  <Text style={styles.pinError}>{pinError}</Text>
                ) : null}
                <LoadingButton
                  style={[
                    styles.cashButton,
                    !canConfirmPin(pinStaff, pinValue, pinBusy) &&
                      styles.buttonDisabled,
                  ]}
                  disabled={!canConfirmPin(pinStaff, pinValue, pinBusy)}
                  loading={pinBusy}
                  onPress={submitPinAndTakeCash}
                  spinnerColor={Colors.white}>
                  <Text style={styles.cashButtonText}>Confirm and take cash</Text>
                </LoadingButton>
              </>
            )}

            <Pressable
              style={styles.pinCancel}
              onPress={() => setPinPromptVisible(false)}>
              <Text style={styles.pinCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/*
        #265 — the recovery sheet. The QR is the whole point: the customer scans it on their own
        phone and the guest half mints them a fresh PIN. Staff never see a PIN at any stage.

        ALL COPY HERE IS **PENDING COPY** — see constants/tabRecoveryCopy, where each string carries
        what it must convey. The owner signs the wording; the facts it must state (customer scans,
        expires shortly, works once) are already ruled on.
      */}
      <Modal
        visible={recoveryVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setRecoveryVisible(false)}>
        <View style={styles.pinBackdrop}>
          <View style={styles.recoveryCard}>
            <Text style={styles.pinTitle}>{TAB_RECOVERY_TITLE}</Text>

            {recoveryBusy ? (
              <ActivityIndicator
                style={styles.pinLoader}
                color={Colors.primary}
              />
            ) : recoveryError ? (
              <Text style={styles.recoveryError}>{recoveryError}</Text>
            ) : recoveryUrl && recoveryExpired ? (
              /*
                REQUIREMENT 4. The QR is GONE, not greyed out or left up with a note beside it —
                a code still on screen is a code that will be scanned, and this one now refuses.
                The customer must not be sent away with something that does not work.
              */
              <>
                <Text style={styles.recoveryExpired}>
                  {TAB_RECOVERY_EXPIRED}
                </Text>
                <Pressable
                  style={styles.recoveryNewCodeButton}
                  disabled={recoveryBusy}
                  onPress={handleStartTabRecovery}>
                  <Text style={styles.recoveryButtonText}>
                    {TAB_RECOVERY_NEW_CODE_LABEL}
                  </Text>
                </Pressable>
              </>
            ) : recoveryUrl ? (
              <>
                {/*
                  White quiet zone behind the code regardless of theme — a QR rendered on a tinted
                  background is the classic reason a phone camera will not lock on to it.
                */}
                <View style={styles.recoveryQrFrame}>
                  <QRCode
                    value={recoveryUrl}
                    size={220}
                    backgroundColor={Colors.white}
                    color={Colors.textPrimary}
                  />
                </View>
                <Text style={styles.recoveryInstruction}>
                  {TAB_RECOVERY_INSTRUCTION}
                </Text>
                {/*
                  The countdown exists so the expiry is never a surprise: staff can see the code is
                  about to die while the customer is still getting their phone out.
                */}
                <Text style={styles.recoveryCountdown}>
                  {tabRecoveryExpiresIn(recoverySecondsLeft)}
                </Text>
              </>
            ) : null}

            <Pressable
              style={styles.pinCancel}
              onPress={() => setRecoveryVisible(false)}>
              <Text style={styles.pinCancelText}>{TAB_RECOVERY_DONE_LABEL}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/*
        #120 residual. Rendered from the close route's own 409 rather than from anything this
        screen guesses: the rows, and per row whether it is a stranded claim or a real round.
      */}
      <StrandedRequestPrompt
        visible={strandedRequests.length > 0}
        requests={strandedRequests}
        message={strandedMessage}
        onDismiss={() => setStrandedRequests([])}
        onReleased={() => {
          // The blocker is gone; the table state staff are looking at is now stale.
          refreshTable();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  cashButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: 10,
    backgroundColor: Colors.green,
  },
  cashButtonText: {
    ...Typography.subheading,
    color: Colors.white,
  },
  pinBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  pinCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: Spacing.lg,
  },
  pinTitle: {
    ...Typography.heading,
    color: Colors.textPrimary,
    marginBottom: Spacing.xs,
  },
  pinHint: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  pinInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.sm,
    color: Colors.textPrimary,
  },
  pinLoader: {marginVertical: Spacing.lg},
  pinEmpty: {
    ...Typography.body,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  pinSectionLabel: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  staffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.xs,
  },
  staffRowSelected: {borderColor: Colors.primary},
  staffRowText: {...Typography.body, color: Colors.textPrimary},
  pinError: {
    ...Typography.small,
    color: Colors.red,
    marginBottom: Spacing.sm,
  },
  pinCancel: {
    marginTop: Spacing.sm,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  pinCancelText: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  container: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  tableTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.textPrimary,
  },
  unpaidTotal: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.green,
    marginTop: Spacing.xs,
  },
  closeBar: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  /** #265 — the PIN-recovery control. Secondary styling: it is a helper, not a settle action. */
  recoveryBar: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.background,
  },
  recoveryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.primary,
    paddingVertical: 12,
  },
  recoveryButtonText: {
    ...Typography.body,
    color: Colors.primary,
    fontWeight: '600',
  },
  recoveryCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: Spacing.lg,
    alignItems: 'center',
  },
  /**
   * A white quiet zone around the code, independent of theme. A QR drawn straight onto a tinted
   * surface, or with no margin, is the usual reason a phone camera will not lock on.
   */
  recoveryQrFrame: {
    backgroundColor: Colors.white,
    padding: Spacing.md,
    borderRadius: 8,
    marginVertical: Spacing.md,
  },
  recoveryInstruction: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  recoveryError: {
    ...Typography.body,
    color: Colors.red,
    textAlign: 'center',
    marginVertical: Spacing.md,
  },
  recoveryCountdown: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  /** Expiry is the design working, not a fault — so this is muted text, not an error colour. */
  recoveryExpired: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginVertical: Spacing.md,
  },
  recoveryNewCodeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.primary,
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  closeButton: {
    backgroundColor: Colors.green,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeButtonText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  list: {
    padding: Spacing.md,
    paddingBottom: 120,
  },
  emptyList: {
    flexGrow: 1,
    padding: Spacing.md,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  orderRowPaid: {
    opacity: 0.5,
  },
  orderInfo: {
    flex: 1,
  },
  orderTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: 2,
  },
  memberName: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    flex: 1,
  },
  orderMeta: {
    ...Typography.small,
    color: Colors.textSecondary,
  },
  orderTotal: {
    ...Typography.subheading,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  /** The order a group of items came from. Quiet: it is context, not a thing to act on. */
  itemGroupHeading: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  itemNotice: {
    ...Typography.small,
    color: Colors.textSecondary,
    paddingVertical: Spacing.sm,
    textAlign: 'center',
  },
  selectionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
  },
  selectionText: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  settleButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  settleButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  settleEntireOutlineButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  settleEntireOutlineText: {
    color: Colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  settleEntireButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  settleEntireButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
