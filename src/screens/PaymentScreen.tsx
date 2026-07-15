import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {usePaymentStateMachine} from '../components/PaymentStateMachine';
import {Colors, Spacing, Typography} from '../constants/theme';
import {closeTable, completePayment, getOrder, recordSaleEvent} from '../lib/api';
import {formatCurrency, getItemUnitPrice} from '../lib/currency';
import {getPostPaymentAction} from '../lib/postPaymentAction';
import {processPaymentIntent} from '../lib/payment';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';
import StatusBadge from '../components/StatusBadge';
import {Order} from '../types';

type Props = NativeStackScreenProps<MainStackParamList, 'Payment'>;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAmountPaid(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `NAD ${safe.toFixed(2)}`;
}

export default function PaymentScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {orderId, tableId, tableNumber, total, orderNumber, placedAt} =
    route.params;
  const {machineState, startPayment, paymentSuccess, paymentFailed, reset} =
    usePaymentStateMachine();
  const [order, setOrder] = useState<Order | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(true);
  const [closingTable, setClosingTable] = useState(false);
  const [canCloseTable, setCanCloseTable] = useState(false);

  const resolvedTableId = order?.table_id ?? tableId;

  const loadOrder = useCallback(async () => {
    setLoadingOrder(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        return;
      }
      const fetched = await getOrder(orderId, token);
      setOrder(fetched);
    } catch {
      // Summary still works from route params
    } finally {
      setLoadingOrder(false);
    }
  }, [orderId]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  const goToOrders = () => {
    reset();
    navigation.navigate('MainTabs', {screen: 'Orders'});
  };

  const handleProcessPayment = async () => {
    startPayment(orderId, total);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }

      const result = await processPaymentIntent(total, orderId);

      if (result.success && result.reference) {
        const paymentResult = await completePayment(orderId, token, {
          status: 'success',
          reference: result.reference,
          amount: total,
          paymentMethod: 'card',
        });

        const businessOrderNo = result.businessOrderNo;
        const transactionId = result.voucherNo;
        if (businessOrderNo && transactionId) {
          recordSaleEvent(
            {
              orderIds: [orderId],
              businessOrderNo,
              transactionId,
              amount: total,
            },
            token,
          ).then(saleRecord => {
            if (!saleRecord.ok) {
              console.warn(
                '[PaymentScreen] recordSaleEvent failed:',
                saleRecord.error,
              );
            }
          });
        } else {
          console.warn(
            '[PaymentScreen] Skipping recordSaleEvent — missing businessOrderNo or voucherNo',
            {
              businessOrderNo,
              voucherNo: transactionId,
            },
          );
        }

        const orderForAction: Order =
          order ?? {
            id: orderId,
            restaurant_id: '',
            table_number: tableNumber,
            order_number: orderNumber ?? 0,
            status: 'ready',
            items: [],
            total,
            placed_at: placedAt ?? new Date().toISOString(),
            channel: 'table',
          };

        const action = getPostPaymentAction(orderForAction, paymentResult.canClose);

        if (action.type === 'auto_return') {
          paymentSuccess(result.reference);
          setTimeout(() => {
            reset();
            navigation.goBack();
          }, action.delayMs);
        } else {
          setCanCloseTable(action.canClose);
          paymentSuccess(result.reference);
        }
      } else {
        await completePayment(orderId, token, {
          status: 'failed',
          reference: result.reference ?? `FT-FAIL-${Date.now()}`,
          amount: total,
          paymentMethod: 'card',
        }).catch(() => {});
        paymentFailed(result.error ?? 'Payment was declined');
      }
    } catch (err) {
      paymentFailed(err instanceof Error ? err.message : 'Payment failed');
    }
  };

  const handleCloseTable = async () => {
    if (!resolvedTableId) {
      Alert.alert(
        'Error',
        'Failed to close table. Please close from the dashboard.',
      );
      goToOrders();
      return;
    }

    setClosingTable(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      await closeTable(resolvedTableId, token);
      goToOrders();
    } catch {
      Alert.alert(
        'Error',
        'Failed to close table. Please close from the dashboard.',
      );
      goToOrders();
    } finally {
      setClosingTable(false);
    }
  };

  const handleBackToOrders = () => {
    goToOrders();
  };

  const {state, error} = machineState;
  const displayOrderNumber = order?.order_number ?? orderNumber;
  const displayPlacedAt = order?.placed_at ?? placedAt ?? new Date().toISOString();
  const items = order?.items ?? [];

  if (state === 'PAYMENT_SUCCESS') {
    return (
      <View style={styles.wrapper}>
        <View style={[styles.successScreen, {paddingBottom: insets.bottom + Spacing.lg}]}>
          <View style={styles.successContent}>
            <MaterialCommunityIcons
              name="check-circle"
              size={72}
              color={Colors.green}
            />
            <Text style={styles.successTitle}>Payment successful</Text>
            <Text style={styles.successAmount}>{formatAmountPaid(total)}</Text>
          </View>

          <View style={styles.successActions}>
            {canCloseTable ? (
              <Pressable
                style={[styles.primaryButton, closingTable && styles.buttonDisabled]}
                disabled={closingTable}
                onPress={handleCloseTable}>
                {closingTable ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.primaryButtonText}>Close Table</Text>
                )}
              </Pressable>
            ) : null}
            <Pressable
              style={[
                canCloseTable ? styles.secondaryButton : styles.primaryButton,
                closingTable && styles.buttonDisabled,
              ]}
              disabled={closingTable}
              onPress={handleBackToOrders}>
              <Text
                style={
                  canCloseTable
                    ? styles.secondaryButtonText
                    : styles.primaryButtonText
                }>
                Back to Orders
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable style={styles.backButton} onPress={() => navigation.goBack()}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <Text style={styles.screenTitle}>Payment</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}>
        <View style={styles.topCard}>
          <Text style={styles.tableLabel}>TABLE</Text>
          <Text style={styles.tableNumber}>{tableNumber}</Text>
          <View style={styles.topCardMeta}>
            <Text style={styles.orderNumber}>Order #{displayOrderNumber}</Text>
            <StatusBadge status="ready" />
          </View>
          <View style={styles.timeRow}>
            <MaterialCommunityIcons
              name="clock-outline"
              size={16}
              color={Colors.textMuted}
            />
            <Text style={styles.time}>{formatTime(displayPlacedAt)}</Text>
          </View>
        </View>

        <Text style={styles.sectionHeader}>Order Summary</Text>
        <View style={styles.summarySection}>
          {loadingOrder ? (
            <ActivityIndicator color={Colors.primary} />
          ) : items.length > 0 ? (
            items.map(item => (
              <View key={item.id} style={styles.itemRow}>
                <Text style={styles.itemName}>
                  {item.quantity}x {item.name}
                </Text>
                <Text style={styles.itemPrice}>
                  {formatCurrency(getItemUnitPrice(item) * item.quantity)}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.itemName}>Order total</Text>
          )}
          <View style={styles.divider} />
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCurrency(total)}</Text>
          </View>
        </View>

        {state !== 'IDLE' ? (
          <>
            <Text style={styles.sectionHeader}>Payment Status</Text>

            {state === 'PAYMENT_IN_PROGRESS' && (
              <View style={styles.processingPill}>
                <Text style={styles.processingText}>
                  ● PROCESSING / Please wait...
                </Text>
              </View>
            )}

            {state === 'PAYMENT_FAILED' && (
              <View style={styles.failedCard}>
                <MaterialCommunityIcons
                  name="alert-circle"
                  size={40}
                  color={Colors.red}
                />
                <Text style={styles.failedTitle}>FAILED</Text>
                <Text style={styles.statusSubtitle}>Payment failed</Text>
                {error ? <Text style={styles.failedError}>{error}</Text> : null}
                <Pressable
                  style={styles.outlinedRedButton}
                  onPress={handleProcessPayment}>
                  <Text style={styles.outlinedRedText}>Retry</Text>
                </Pressable>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      <View style={[styles.bottomBar, {paddingBottom: insets.bottom + Spacing.md}]}>
        <Pressable
          style={[
            styles.processButton,
            state === 'PAYMENT_IN_PROGRESS' && styles.buttonDisabled,
          ]}
          disabled={state === 'PAYMENT_IN_PROGRESS'}
          onPress={handleProcessPayment}>
          <MaterialCommunityIcons
            name="credit-card-outline"
            size={22}
            color={Colors.white}
          />
          <View style={styles.processButtonTextWrap}>
            <Text style={styles.processButtonTitle}>Process Payment</Text>
            <Text style={styles.processButtonSubtitle}>
              Tap card or insert to pay
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  successScreen: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl * 2,
    justifyContent: 'space-between',
  },
  successContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
  },
  successTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginTop: Spacing.md,
  },
  successAmount: {
    fontSize: 32,
    fontWeight: '800',
    color: Colors.green,
  },
  successActions: {
    gap: Spacing.md,
    width: '100%',
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    width: '100%',
  },
  primaryButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    width: '100%',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  secondaryButtonText: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screenTitle: {
    flex: 1,
    textAlign: 'center',
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: Spacing.lg,
    paddingBottom: 120,
  },
  topCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  tableLabel: {
    ...Typography.tiny,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1,
  },
  tableNumber: {
    fontSize: 56,
    fontWeight: '800',
    color: Colors.green,
    marginVertical: Spacing.xs,
  },
  topCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  orderNumber: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  time: {
    ...Typography.small,
    color: Colors.textMuted,
  },
  sectionHeader: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  summarySection: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.lg,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  itemName: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
  itemPrice: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  totalValue: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.green,
  },
  processingPill: {
    backgroundColor: Colors.blueLight,
    borderRadius: 24,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  processingText: {
    ...Typography.subheading,
    color: Colors.blue,
  },
  failedCard: {
    backgroundColor: Colors.redLight,
    borderRadius: 12,
    padding: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.red,
    gap: Spacing.xs,
  },
  failedTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.red,
    letterSpacing: 1,
  },
  statusSubtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  failedError: {
    ...Typography.small,
    color: Colors.red,
    textAlign: 'center',
  },
  outlinedRedButton: {
    marginTop: Spacing.sm,
    borderWidth: 1.5,
    borderColor: Colors.red,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    minWidth: 120,
    alignItems: 'center',
  },
  outlinedRedText: {
    ...Typography.subheading,
    color: Colors.red,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  processButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  processButtonTextWrap: {
    flex: 1,
  },
  processButtonTitle: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  processButtonSubtitle: {
    color: '#D4D4D8',
    ...Typography.tiny,
    marginTop: 2,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
