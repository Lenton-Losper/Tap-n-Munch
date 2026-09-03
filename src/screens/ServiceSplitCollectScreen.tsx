import React, {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/serviceCopy';
import {ApiRequestError, getTabLines, settleAllocations} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {
  formatCents,
  personSplits,
  tabRemainderCents,
  type SplittableLine,
} from '../lib/splitBill';
import type {TabLinesPayload} from '../lib/tabLines';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceSplitCollect'>;

/**
 * SPLIT, SCREEN 2 — take one person's share.
 *
 * ============================================================================================
 * PARTIAL BY DESIGN. THIS SCREEN NEVER CLOSES A TABLE.
 * ============================================================================================
 *
 * The owner's ruling: a partially-paid tab still accepts further rounds, and an unpaid remainder
 * is a WALKOUT handled by senior staff (Ship 2) -- not a new state, and not something this screen
 * decides. So the only outcome here is "this person has paid", and the remainder is displayed
 * rather than acted on.
 *
 * The server keeps that true: settle-allocations writes money ONLY to the append-only
 * order_line_allocation_settlements ledger, and flips an order to paid only when
 * order_is_fully_paid_by_allocations() -- SQL, integer cents -- says every line on it is covered.
 * Nothing here can mark a tab settled.
 *
 * ============================================================================================
 * THE TWO REFUSALS A WAITER WILL ACTUALLY MEET
 * ============================================================================================
 *
 * CARD_PAYMENT_IN_FLIGHT (409). A card is going through on one of these orders and taking cash
 * alongside it would charge the customer twice. The wording shown is Copy.SPLIT_CARD_IN_FLIGHT,
 * which is deliberately the same sentence the server sends -- two different sentences for one
 * refusal is how staff conclude the terminal is broken rather than that a card is still running.
 *
 * NOTHING_SETTLED (409). Every allocation in the request was already settled, or was voided out
 * from under it. Shown as Copy.SPLIT_NOTHING_SETTLED rather than as a raw error, because "none of
 * these could be paid" is actionable and "409" is not.
 */
export default function ServiceSplitCollectScreen({route, navigation}: Props) {
  const {tabId, tableNumber, name} = route.params;
  const insets = useSafeAreaInsets();

  const [payload, setPayload] = useState<TabLinesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getTerminalToken();
      if (!token) {
        setError('This terminal is not signed in.');
        return;
      }
      setPayload(await getTabLines(tabId, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this table.');
    } finally {
      setLoading(false);
    }
  }, [tabId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const lines = useMemo(
    () => (payload?.orders ?? []).flatMap(o => o.lines) as SplittableLine[],
    [payload],
  );
  const person = useMemo(
    () => personSplits(lines).find(p => p.name === name) ?? null,
    [lines, name],
  );
  const remainder = useMemo(() => tabRemainderCents(lines), [lines]);

  const collect = useCallback(
    async (method: 'cash' | 'card') => {
      if (!person || person.unsettledAllocationIds.length === 0) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const token = await getTerminalToken();
        if (!token) {
          setError('This terminal is not signed in.');
          return;
        }
        const result = await settleAllocations(
          tabId,
          {allocationIds: person.unsettledAllocationIds, method},
          token,
        );
        if (result.applied.length === 0) {
          setError(Copy.SPLIT_NOTHING_SETTLED);
          await load();
          return;
        }
        setDone(true);
        await load();
      } catch (err) {
        // The server's named refusals get the signed wording; anything else shows its own message
        // rather than being flattened into a generic failure.
        const code = err instanceof ApiRequestError ? err.code : null;
        if (code === 'CARD_PAYMENT_IN_FLIGHT') {
          setError(Copy.SPLIT_CARD_IN_FLIGHT);
        } else if (code === 'NOTHING_SETTLED') {
          setError(Copy.SPLIT_NOTHING_SETTLED);
        } else {
          setError(err instanceof Error ? err.message : 'Could not take this payment.');
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [person, tabId, load],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  const owed = person?.unsettledCents ?? 0;

  return (
    <View style={styles.screen}>
      <View style={[styles.header, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12} testID="collect-back">
          <MaterialCommunityIcons name="chevron-left" size={30} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {Copy.SPLIT_COLLECT_TITLE.replace('{name}', name)}
        </Text>
        <Text style={styles.headerTable}>{tableNumber}</Text>
      </View>

      {error ? (
        <View style={styles.errorBanner} testID="collect-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.owed} testID="collect-owed">
          {Copy.SPLIT_COLLECT_TOTAL.replace('{name}', name).replace('{amount}', formatCents(owed))}
        </Text>

        {person?.settledCents ? (
          <Text style={styles.alreadyPaid} testID="collect-already-paid">
            {formatCents(person.settledCents)} already paid
          </Text>
        ) : null}

        {/* What stays open after this. The remainder is shown, never acted on -- an unpaid
            remainder is a walkout, which is Ship 2 and senior staff, not this screen. */}
        <Text style={styles.remainder} testID="collect-remainder">
          {Copy.SPLIT_REMAINDER_OPEN.replace('{amount}', formatCents(remainder))}
        </Text>
      </ScrollView>

      <View style={[styles.actions, {paddingBottom: insets.bottom + Spacing.md}]}>
        {done || owed === 0 ? (
          <Pressable
            testID="collect-close"
            style={styles.doneButton}
            onPress={() => navigation.goBack()}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              testID="collect-cash"
              disabled={busy}
              onPress={() => collect('cash')}
              style={[styles.payButton, busy && styles.payButtonDisabled]}>
              {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.payText}>Cash</Text>}
            </Pressable>
            <Pressable
              testID="collect-card"
              disabled={busy}
              onPress={() => collect('card')}
              style={[styles.payButton, styles.payButtonSecondary, busy && styles.payButtonDisabled]}>
              <Text style={[styles.payText, styles.payTextSecondary]}>Card</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: Colors.background},
  centered: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  headerTitle: {...Typography.heading, color: Colors.textPrimary, flex: 1},
  headerTable: {...Typography.body, color: Colors.textSecondary, fontWeight: '800'},
  errorBanner: {backgroundColor: '#FEF2F2', padding: Spacing.sm, marginHorizontal: Spacing.md},
  errorText: {...Typography.small, color: '#991B1B'},
  body: {padding: Spacing.md, gap: Spacing.sm},
  owed: {...Typography.heading, color: Colors.textPrimary},
  alreadyPaid: {...Typography.small, color: Colors.textSecondary},
  remainder: {...Typography.small, color: Colors.textSecondary, marginTop: Spacing.md},
  actions: {flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md},
  payButton: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  payButtonSecondary: {backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: Colors.primary},
  payButtonDisabled: {opacity: 0.4},
  payText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
  payTextSecondary: {color: Colors.primary},
  doneButton: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  doneText: {...Typography.body, color: '#FFFFFF', fontWeight: '800'},
});
