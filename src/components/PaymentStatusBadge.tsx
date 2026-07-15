import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Colors, Spacing, Typography} from '../constants/theme';

interface PaymentStatusBadgeProps {
  /** null/undefined renders as PAID — matches orders with no derived refund data yet. */
  status?: 'paid' | 'partially_refunded' | 'refunded' | null;
}

export default function PaymentStatusBadge({status}: PaymentStatusBadgeProps) {
  if (status === 'refunded') {
    return (
      <View style={[styles.badge, styles.refundedBadge]}>
        <Text style={[styles.badgeText, styles.refundedBadgeText]}>
          REFUNDED
        </Text>
      </View>
    );
  }
  if (status === 'partially_refunded') {
    return (
      <View style={[styles.badge, styles.partiallyRefundedBadge]}>
        <Text style={[styles.badgeText, styles.partiallyRefundedBadgeText]}>
          PARTIALLY REFUNDED
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>PAID</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: Colors.greenLight,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.green,
  },
  badgeText: {
    ...Typography.tiny,
    fontWeight: '800',
    color: Colors.green,
    letterSpacing: 0.5,
  },
  refundedBadge: {
    backgroundColor: Colors.surface,
    borderColor: Colors.textMuted,
  },
  refundedBadgeText: {
    color: Colors.textMuted,
  },
  partiallyRefundedBadge: {
    backgroundColor: Colors.orangeLight,
    borderColor: Colors.orange,
  },
  partiallyRefundedBadgeText: {
    color: Colors.orange,
  },
});
