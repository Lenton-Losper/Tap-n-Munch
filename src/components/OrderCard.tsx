import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Colors, Spacing, Typography} from '../constants/theme';
import {formatCurrency} from '../lib/currency';
import {getStatusColor} from '../lib/statusColors';
import {Order} from '../types';
import StatusBadge from './StatusBadge';

interface OrderCardProps {
  order: Order;
  onPress: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function OrderCard({order, onPress}: OrderCardProps) {
  const statusColor = getStatusColor(order.status);

  return (
    <Pressable
      style={({pressed}) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}>
      <View style={styles.topRow}>
        <Text style={[styles.tableNumber, {color: statusColor}]}>
          {order.table_number}
        </Text>
        <View style={styles.topRight}>
          <Text style={styles.orderNumber}>#{order.order_number}</Text>
          <StatusBadge status={order.status} />
          <Text style={styles.time}>{formatTime(order.placed_at)}</Text>
        </View>
      </View>

      {order.member_name ? (
        <Text style={styles.memberName}>{order.member_name}</Text>
      ) : null}

      <View style={styles.items}>
        {order.items.map(item => (
          <Text key={item.id} style={styles.itemLine}>
            {item.quantity}x {item.name}
            {item.variant ? ` (${item.variant})` : ''}
          </Text>
        ))}
      </View>

      <View style={styles.footer}>
        <Text style={styles.total}>{formatCurrency(order.total)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardPressed: {
    opacity: 0.92,
    backgroundColor: Colors.surface,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: Spacing.sm,
  },
  tableNumber: {
    fontSize: 48,
    fontWeight: '800',
    lineHeight: 52,
  },
  topRight: {
    alignItems: 'flex-end',
    gap: Spacing.xs,
  },
  orderNumber: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  time: {
    ...Typography.tiny,
    color: Colors.textMuted,
  },
  memberName: {
    ...Typography.small,
    color: Colors.textSecondary,
    fontStyle: 'italic',
    marginBottom: Spacing.sm,
  },
  items: {
    marginBottom: Spacing.md,
    gap: 2,
  },
  itemLine: {
    ...Typography.small,
    color: Colors.textPrimary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.sm,
  },
  total: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
});
