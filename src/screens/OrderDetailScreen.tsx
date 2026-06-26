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
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import StatusBadge from '../components/StatusBadge';
import {Colors, Spacing, Typography} from '../constants/theme';
import {getOrder, updateOrderStatus} from '../lib/api';
import {formatCurrency, getItemUnitPrice} from '../lib/currency';
import {getStatusColor} from '../lib/statusColors';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';
import {Order, OrderStatus} from '../types';

type Props = NativeStackScreenProps<MainStackParamList, 'OrderDetail'>;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function OrderDetailScreen({route}: Props) {
  const insets = useSafeAreaInsets();
  const navigation =
    useNavigation<NativeStackNavigationProp<MainStackParamList>>();
  const {orderId} = route.params;
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOrder = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const fetched = await getOrder(orderId, token);
      setOrder(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  const handleStatusUpdate = async (newStatus: OrderStatus) => {
    if (!order) {
      return;
    }

    const token = await getTerminalToken();
    if (!token) {
      Alert.alert('Error', 'Session expired');
      return;
    }

    const previous = order;
    setOrder({...order, status: newStatus});
    setUpdating(true);
    setError(null);

    if (newStatus === 'confirmed') {
      console.log('[Accept Order]', {
        orderId: order.id,
        orderUUID: order.id,
        status: 'confirmed',
        orderNumber: order.order_number,
      });
    }

    try {
      await updateOrderStatus(order.id, newStatus, token);
      if (newStatus === 'completed' || newStatus === 'cancelled') {
        navigation.goBack();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      console.log('[OrderDetail] update error:', message);
      console.log('[OrderDetail] orderId:', order.id);
      console.log('[OrderDetail] new status:', newStatus);
      setOrder(previous);
      setError(message);
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (!order) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Order not found'}</Text>
        <Pressable style={styles.outlinedButton} onPress={loadOrder}>
          <Text style={styles.outlinedButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const statusColor = getStatusColor(order.status);

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
        <Text style={styles.screenTitle}>Order Details</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}>
        <Text style={[styles.tableNumber, {color: statusColor}]}>
          {order.table_number}
        </Text>

        <View style={styles.metaRow}>
          <Text style={styles.orderNumber}>Order #{order.order_number}</Text>
          <StatusBadge status={order.status} />
        </View>

        <View style={styles.timeRow}>
          <MaterialCommunityIcons
            name="clock-outline"
            size={16}
            color={Colors.textMuted}
          />
          <Text style={styles.time}>{formatTime(order.placed_at)}</Text>
        </View>

        {order.member_name ? (
          <Text style={styles.memberName}>{order.member_name}</Text>
        ) : null}

        <Text style={styles.sectionHeader}>Items</Text>
        <View style={styles.itemsSection}>
          {order.items.map((item, index) => {
            const unitPrice = getItemUnitPrice(item);
            return (
              <View key={item.id ?? index} style={styles.itemRow}>
                <Text style={styles.itemName}>
                  {item.quantity}x {item.name}
                  {item.variant ? ` (${item.variant})` : ''}
                </Text>
                <Text style={styles.itemPrice}>
                  {formatCurrency(unitPrice * item.quantity)}
                </Text>
              </View>
            );
          })}
        </View>

        <View style={styles.divider} />

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatCurrency(order.total)}</Text>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          {order.status === 'pending' && (
            <>
              <Pressable
                style={[styles.primaryButton, updating && styles.buttonDisabled]}
                disabled={updating}
                onPress={() => handleStatusUpdate('confirmed')}>
                <Text style={styles.primaryButtonText}>✓ Accept Order</Text>
              </Pressable>
              <Pressable
                style={[styles.outlinedButton, updating && styles.buttonDisabled]}
                disabled={updating}
                onPress={() => handleStatusUpdate('cancelled')}>
                <Text style={styles.outlinedButtonText}>✗ Decline Order</Text>
              </Pressable>
            </>
          )}

          {order.status === 'confirmed' && (
            <Pressable
              style={[styles.primaryButton, updating && styles.buttonDisabled]}
              disabled={updating}
              onPress={() => handleStatusUpdate('preparing')}>
              <Text style={styles.primaryButtonText}>Start Preparing</Text>
            </Pressable>
          )}

          {order.status === 'preparing' && (
            <Pressable
              style={[styles.primaryButton, updating && styles.buttonDisabled]}
              disabled={updating}
              onPress={() => handleStatusUpdate('ready')}>
              <Text style={styles.primaryButtonText}>Mark Ready</Text>
            </Pressable>
          )}

          {order.status === 'ready' && (
            <>
              <Pressable
                style={styles.greenButton}
                onPress={() =>
                  navigation.navigate('Payment', {
                    orderId: order.id,
                    tableId: order.table_id,
                    tableNumber: order.table_number,
                    total: order.total,
                    orderNumber: order.order_number,
                    placedAt: order.placed_at,
                  })
                }>
                <Text style={styles.primaryButtonText}>Process Payment</Text>
              </Pressable>
              <Pressable
                style={[styles.outlinedButton, updating && styles.buttonDisabled]}
                disabled={updating}
                onPress={() => handleStatusUpdate('completed')}>
                <Text style={styles.outlinedButtonText}>Mark Completed</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.background,
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
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    backgroundColor: Colors.background,
  },
  tableNumber: {
    ...Typography.tableNumber,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
    marginBottom: Spacing.md,
  },
  time: {
    ...Typography.small,
    color: Colors.textMuted,
  },
  memberName: {
    ...Typography.body,
    color: Colors.textSecondary,
    fontStyle: 'italic',
    marginBottom: Spacing.md,
  },
  sectionHeader: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  itemsSection: {
    marginBottom: Spacing.md,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  itemName: {
    flex: 1,
    ...Typography.body,
    color: Colors.textPrimary,
    marginRight: Spacing.md,
  },
  itemPrice: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.md,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  totalLabel: {
    ...Typography.heading,
    color: Colors.textPrimary,
  },
  totalValue: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.green,
  },
  actions: {
    gap: Spacing.md,
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
  },
  greenButton: {
    backgroundColor: Colors.green,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  outlinedButton: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  outlinedButtonText: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  errorText: {
    color: Colors.red,
    ...Typography.small,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
});
