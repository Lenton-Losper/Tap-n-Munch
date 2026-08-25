import React, {useCallback, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  HELD_ORPHAN_ACKNOWLEDGE,
  HELD_ORPHAN_BODY,
  HELD_ORPHAN_BODY_UNKNOWN_ORDER,
  HELD_ORPHAN_TITLE,
} from '../constants/paymentCopy';
import {
  clearHeldOrphanPayments,
  getHeldOrphanPayments,
  type HeldOrphanPayment,
} from '../lib/storage';

/**
 * #344 — tells the operator that a card payment was recovered and NOT applied to this order.
 *
 * THE THIRD PART OF THE RULING. Cases 2 and 3 say do not apply and do not discard; this is the
 * "and tell the operator plainly" half. Without it the hold is a silent write to storage that
 * nobody ever reads, which is only marginally better than the discard it replaced.
 *
 * DELIBERATELY NOT A MODAL. It sits above the payment in progress rather than interrupting it: the
 * held payment belongs to a DIFFERENT order and says nothing about the sale the operator is taking
 * right now. Blocking that sale to report an unrelated one would make staff dismiss the message
 * reflexively, which is how a notice stops being read.
 *
 * ACKNOWLEDGING DELETES THE ONLY REMAINING RECORD. Native's consume is destructive, so this store
 * is the last copy of that transaction — which is why the action is worded as "I have checked
 * this" rather than "dismiss", and why nothing clears it automatically. Whether acknowledging
 * ought to require the payment be reconciled FIRST is a ruling, not an implementation detail, and
 * is open with the owner.
 */
export default function HeldOrphanPaymentNotice() {
  const [held, setHeld] = useState<HeldOrphanPayment[]>([]);

  // Re-read on focus, not only on mount: the hold is written by processPaymentIntent DURING a
  // payment on this same screen, so a mount-only read would miss the one that just happened.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getHeldOrphanPayments().then(rows => {
        if (!cancelled) {
          setHeld(rows);
        }
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (held.length === 0) {
    return null;
  }

  const acknowledge = async () => {
    await clearHeldOrphanPayments();
    setHeld([]);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialCommunityIcons
          name="alert-decagram"
          size={22}
          color={Colors.amber}
        />
        <Text style={styles.title}>{HELD_ORPHAN_TITLE}</Text>
      </View>

      {held.map(row => (
        <View key={`${row.heldAt}-${row.voucherNo ?? 'no-voucher'}`}>
          <Text style={styles.body}>
            {row.reason === 'unknown_order'
              ? HELD_ORPHAN_BODY_UNKNOWN_ORDER
              : HELD_ORPHAN_BODY}
          </Text>
          {/*
            The voucher is the operator's handle on the actual transaction — it is what they will
            search for on the reader or quote to support. A notice that says "a payment exists"
            without saying WHICH cannot be acted on.
          */}
          {row.voucherNo ? (
            <Text style={styles.detail}>Voucher {row.voucherNo}</Text>
          ) : null}
          {row.orphanOrderId ? (
            <Text style={styles.detail}>Order {row.orphanOrderId}</Text>
          ) : null}
        </View>
      ))}

      <Pressable style={styles.ackButton} onPress={acknowledge}>
        <Text style={styles.ackText}>{HELD_ORPHAN_ACKNOWLEDGE}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.amberLight,
    borderWidth: 1,
    borderColor: Colors.amber,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  title: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    flexShrink: 1,
  },
  body: {
    ...Typography.small,
    color: Colors.textPrimary,
    marginTop: Spacing.xs,
  },
  detail: {
    ...Typography.tiny,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  ackButton: {
    marginTop: Spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.amber,
  },
  ackText: {
    ...Typography.small,
    color: Colors.amber,
    fontWeight: '600',
  },
});
