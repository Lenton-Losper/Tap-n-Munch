import React, {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import PaymentStatusBadge from '../components/PaymentStatusBadge';
import {
  closeTable,
  completePaymentReliably,
  getTables,
  recordSaleEvent,
  settleTab,
} from '../lib/api';
import {
  declinedFailureReference,
  processPaymentIntent,
  resolveAmbiguousPaymentWithFinatic,
  unconfirmedFailureReference,
} from '../lib/payment';
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

export default function TableDetailScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const [table, setTable] = useState<TableWithTab>(route.params.table);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [closingTable, setClosingTable] = useState(false);
  const [settling, setSettling] = useState(false);

  const tab = table.tab;
  const orders = useMemo(() => tab?.orders ?? [], [tab?.orders]);

  const unpaidOrders = useMemo(
    () => orders.filter(order => !isPaid(order)),
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

  const refreshTable = useCallback(async () => {
    setRefreshing(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const tables = await getTables(token);
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
    if (isPaid(order)) {
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

  const runSettle = async (orderIds: string[]) => {
    if (orderIds.length === 0) {
      return;
    }

    const ordersToSettle = orders.filter(o => orderIds.includes(o.id));
    const amount = ordersToSettle.reduce((sum, o) => sum + o.total, 0);

    if (amount <= 0) {
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
              unpaid_total: settleResult.new_tab_total,
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
    const fullyRefunded = item.payment_status_derived === 'refunded';
    const selected = selectedIds.has(item.id);
    const itemCount = item.items.length;

    return (
      <Pressable
        style={[styles.orderRow, paid && styles.orderRowPaid]}
        disabled={settling || fullyRefunded}
        onPress={() =>
          paid ? handlePaidOrderPress(item) : toggleOrderSelection(item)
        }>
        <MaterialCommunityIcons
          name={
            paid
              ? 'checkbox-blank-outline'
              : selected
                ? 'checkbox-marked'
                : 'checkbox-blank-outline'
          }
          size={24}
          color={paid ? Colors.textMuted : Colors.primary}
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
          <Pressable
            style={[
              styles.settleEntireOutlineButton,
              (settling || unpaidOrders.length === 0) && styles.buttonDisabled,
            ]}
            disabled={settling || unpaidOrders.length === 0}
            onPress={handleSettleEntireTab}>
            <Text style={styles.settleEntireOutlineText}>Settle Entire Tab</Text>
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.bottomBar,
            {paddingBottom: insets.bottom + Spacing.md},
          ]}>
          <Pressable
            style={[
              styles.settleEntireButton,
              (settling || unpaidOrders.length === 0) && styles.buttonDisabled,
            ]}
            disabled={settling || unpaidOrders.length === 0}
            onPress={handleSettleEntireTab}>
            {settling ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.settleEntireButtonText}>Settle Entire Tab</Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
