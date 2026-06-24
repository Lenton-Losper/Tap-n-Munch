import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Colors, Typography} from '../constants/theme';
import {getStatusColor} from '../lib/statusColors';
import {OrderStatus} from '../types';

interface StatusBadgeProps {
  status: OrderStatus;
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'NEW',
  confirmed: 'ACCEPTED',
  preparing: 'PREPARING',
  ready: 'READY',
  completed: 'DONE',
  cancelled: 'CANCELLED',
};

export default function StatusBadge({status}: StatusBadgeProps) {
  const backgroundColor = getStatusColor(status);

  return (
    <View style={[styles.badge, {backgroundColor}]}>
      <Text style={styles.label}>{STATUS_LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  label: {
    ...Typography.tiny,
    fontWeight: '700',
    color: Colors.white,
    letterSpacing: 0.5,
  },
});
