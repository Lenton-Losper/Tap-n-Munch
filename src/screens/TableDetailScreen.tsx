import React, {useCallback, useEffect, useMemo, useState} from 'react';
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
import {
  ApiRequestError,
  authorizeTerminalAction,
  closeTable,
  completePaymentReliably,
  getTablesWithMeta,
  recordSaleEvent,
  settleTab,
} from '../lib/api';
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
  const [refreshing, setRefreshing] = useState(false);
  const [closingTable, setClosingTable] = useState(false);
  const [settling, setSettling] = useState(false);
  const [cashSettling, setCashSettling] = useState(false);
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
  const [pinStaffId, setPinStaffId] = useState('');
  const [pinValue, setPinValue] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const tab = table.tab;
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
    } catch {
      Alert.alert(
        'Error',
        'Failed to close table. Please close from dashboard.',
      );
    } finally {
      setClosingTable(false);
    }
  };

  const runSettle = async (requestedOrderIds: string[]) => {
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
        throw new Error(
          completed
            ? baseError
            : `${baseError} — could not notify the system. Contact support before retrying.`,
        );
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
  const runCashSettle = async (
    requestedOrderIds: string[],
    attribution?: {staffUserId: string; authorizationTokenId: string},
  ) => {
    // Server-driven: only orders the server says are cash-settleable, and the amount is
    // derived from that same set so the two can never disagree.
    const eligible = orders.filter(
      order =>
        requestedOrderIds.includes(order.id) && order.can_settle_cash === true,
    );
    const orderIds = eligible.map(order => order.id);
    const amount = eligible.reduce((sum, order) => sum + order.total, 0);

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
      setCashSettling(false);
    }
  };

  /** Verify the staff PIN, then take the cash with that person attributed to it. */
  const submitPinAndTakeCash = async () => {
    setPinBusy(true);
    setPinError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const {token_id} = await authorizeTerminalAction(
        pinStaffId.trim(),
        pinValue.trim(),
        'cash_settlement',
        token,
      );
      const ids = Array.from(selectedIds);
      setPinPromptVisible(false);
      setPinValue('');
      await runCashSettle(ids, {
        staffUserId: pinStaffId.trim(),
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
    const ids =
      selectedIds.size > 0
        ? Array.from(selectedIds)
        : cashSettleableOrders.map(o => o.id);
    if (ids.length === 0) {
      return;
    }
    setSelectedIds(new Set(ids));
    // Attribution is offered, never forced — Skip still records the settlement.
    Alert.alert(
      'Staff PIN',
      'Enter a staff PIN to record who took this cash, or skip.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Skip', onPress: () => runCashSettle(ids)},
        {
          text: 'Enter PIN',
          onPress: () => {
            setPinError(null);
            setPinValue('');
            setPinPromptVisible(true);
          },
        },
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
    runSettle(Array.from(selectedIds));
  };

  const handleSettleEntireTab = () => {
    const unpaidIds = unpaidOrders.map(o => o.id);
    setSelectedIds(new Set(unpaidIds));
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

      <FlatList
        data={orders}
        keyExtractor={item => item.id}
        renderItem={renderOrderRow}
        contentContainerStyle={
          orders.length === 0 ? styles.emptyList : styles.list
        }
        refreshing={refreshing}
        onRefresh={refreshTable}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No orders on this tab</Text>
          </View>
        }
      />

      {selectedIds.size > 0 ? (
        <View
          style={[
            styles.selectionBar,
            {paddingBottom: insets.bottom + Spacing.sm},
          ]}>
          <Text style={styles.selectionText}>
            {selectedIds.size} {selectedIds.size === 1 ? 'order' : 'orders'}{' '}
            selected — {formatNad(selectedTotal)}
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
          {renderCashButton(selectedCashOrders.length)}
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
          {renderCashButton(cashSettleableOrders.length)}
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
            <TextInput
              style={styles.pinInput}
              placeholder="Staff user ID"
              autoCapitalize="none"
              autoCorrect={false}
              value={pinStaffId}
              onChangeText={setPinStaffId}
            />
            <TextInput
              style={styles.pinInput}
              placeholder="4-digit PIN"
              keyboardType="number-pad"
              secureTextEntry
              maxLength={4}
              value={pinValue}
              onChangeText={setPinValue}
            />
            {pinError ? (
              <Text style={styles.pinError}>{pinError}</Text>
            ) : null}
            <LoadingButton
              style={[
                styles.cashButton,
                (pinBusy || pinValue.length !== 4 || !pinStaffId.trim()) &&
                  styles.buttonDisabled,
              ]}
              disabled={pinBusy || pinValue.length !== 4 || !pinStaffId.trim()}
              loading={pinBusy}
              onPress={submitPinAndTakeCash}
              spinnerColor={Colors.white}>
              <Text style={styles.cashButtonText}>Confirm and take cash</Text>
            </LoadingButton>
            <Pressable
              style={styles.pinCancel}
              onPress={() => setPinPromptVisible(false)}>
              <Text style={styles.pinCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
