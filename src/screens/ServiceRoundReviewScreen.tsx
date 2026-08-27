import React, {useCallback, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  ApiRequestError,
  RoundLinesNotWrittenError,
  RoundOutOfStockError,
  RoundResult,
  sendRound,
  StationCounts,
  TabNotOpenError,
} from '../lib/api';
import {
  basketCount,
  basketSubtotal,
  buildRoundItems,
  outOfStockLineIds,
} from '../lib/serviceRound';
import {getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceRoundReview'>;

function formatMoney(amount: number): string {
  return `N$${amount.toFixed(2)}`;
}

function stationSummary(counts: StationCounts): string {
  const parts: string[] = [];
  if (counts.kitchen > 0) {
    parts.push(`${counts.kitchen} to kitchen`);
  }
  if (counts.bar > 0) {
    parts.push(`${counts.bar} to bar`);
  }
  return parts.length > 0 ? parts.join(', ') : 'No station lines';
}

/** What the screen is showing. Only one of these is ever true at a time. */
type Outcome =
  | {kind: 'sent'; result: RoundResult}
  | {kind: 'lines_not_written'; message: string; orderNumber: number | null}
  | {kind: 'tab_closed'; message: string}
  | {kind: 'gone'; message: string}
  | {kind: 'error'; message: string};

export default function ServiceRoundReviewScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {
    table,
    lines,
    idempotencyKey,
    orderInstructions,
    setOrderInstructions,
    clearBasket,
    endSession,
  } = useServiceSession();

  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Snapshotted before endSession clears the context, so the panel survives the drop. */
  const [sentTableLabel, setSentTableLabel] = useState('');

  const backToFloor = useCallback(() => {
    endSession();
    navigation.popToTop();
  }, [endSession, navigation]);

  const handleSend = useCallback(async () => {
    if (!table || sending) {
      return;
    }
    const items = buildRoundItems(lines);
    if (items.length === 0) {
      setOutcome({
        kind: 'error',
        message: 'Nothing to send. Add at least one item.',
      });
      return;
    }
    if (!idempotencyKey) {
      // Mandatory on this route — a request without the header is 400 IDEMPOTENCY_KEY_REQUIRED.
      setOutcome({
        kind: 'error',
        message: 'This round lost its send key. Rebuild the round and try again.',
      });
      return;
    }

    setSending(true);
    setOutcome(null);

    const label = table.tableName
      ? `Table ${table.tableNumber} · ${table.tableName}`
      : `Table ${table.tableNumber}`;

    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Terminal session not found. Re-activate this terminal.');
      }

      const subtotal = basketSubtotal(lines);
      const result = await sendRound(
        {
          tabId: table.tabId,
          items,
          // Advisory only — the server re-prices from the catalog and ignores both figures.
          // Sent anyway so a mismatch is visible server-side, never relied on for the bill.
          subtotal,
          total: subtotal,
          orderInstructions,
          // Reused verbatim on every retry of THIS round. A repeat carrying an already-used key
          // returns the original order with 200, which lands in the success branch below —
          // correctly, because that is exactly one round on the tab.
          idempotencyKey,
        },
        token,
      );

      // THE SEND-DROPS-THE-PIN-SESSION RULE. On any 2xx the held identity goes, immediately, so
      // the next table costs a PIN again. The round itself is attributed server-side from the
      // tab, so nothing about this affects who gets credit for what was just sent.
      setSentTableLabel(label);
      endSession();
      setOutcome({kind: 'sent', result});
    } catch (err) {
      if (err instanceof RoundLinesNotWrittenError) {
        // Billed, but the kitchen and bar were never told. Not retryable — a retry double-bills.
        // The basket goes, because the round IS on the tab; the message and order number stay.
        setSentTableLabel(label);
        clearBasket();
        setOutcome({
          kind: 'lines_not_written',
          message: err.message,
          orderNumber: err.orderNumber,
        });
        return;
      }

      if (err instanceof RoundOutOfStockError) {
        // Every refused item lights up at once, back in the basket. The round survives.
        const flagged = outOfStockLineIds(lines, err.outOfStock);
        navigation.navigate('ServiceRound', {outOfStockLineIds: flagged});
        return;
      }

      if (err instanceof TabNotOpenError) {
        // Do NOT discard the basket. Offer to re-open the table and send it again.
        setOutcome({kind: 'tab_closed', message: err.message});
        return;
      }

      if (err instanceof ApiRequestError && err.status === 404) {
        setOutcome({
          kind: 'gone',
          message: `${err.message}. Return to the floor and refresh.`,
        });
        return;
      }

      setOutcome({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not send the round.',
      });
    } finally {
      setSending(false);
    }
  }, [
    clearBasket,
    endSession,
    idempotencyKey,
    lines,
    navigation,
    orderInstructions,
    sending,
    table,
  ]);

  if (outcome?.kind === 'sent') {
    const {result} = outcome;
    return (
      <View style={[styles.wrapper, {paddingTop: insets.top}]}>
        <ScrollView contentContainerStyle={styles.resultContent}>
          <MaterialCommunityIcons
            name="check-circle-outline"
            size={56}
            color={Colors.green}
          />
          <Text style={styles.resultTitle}>Round sent</Text>
          <Text style={styles.resultSubtitle}>{sentTableLabel}</Text>
          <Text style={styles.orderNumber}>Order #{result.order_number}</Text>
          <Text style={styles.resultBody}>
            {stationSummary(result.station_counts)} · {result.line_count}{' '}
            {result.line_count === 1 ? 'line' : 'lines'}
          </Text>

          {/* unrouted > 0 is shown loudly on purpose: those items have no usable routing and
              BOTH station screens will show them flagged. It is a menu problem, and the waiter
              is the first person in a position to notice it. */}
          {result.station_counts.unrouted > 0 ? (
            <View style={styles.unroutedPanel}>
              <MaterialCommunityIcons
                name="alert-outline"
                size={22}
                color={Colors.amber}
              />
              <Text style={styles.unroutedText}>
                {result.station_counts.unrouted}{' '}
                {result.station_counts.unrouted === 1 ? 'item' : 'items'} could
                not be routed to a station. The kitchen and bar will both see
                them flagged — tell a manager the menu routing needs fixing.
              </Text>
            </View>
          ) : null}

          <Pressable style={styles.primaryButton} onPress={backToFloor}>
            <Text style={styles.primaryButtonText}>Back to Floor</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (outcome?.kind === 'lines_not_written') {
    return (
      <View style={[styles.wrapper, {paddingTop: insets.top}]}>
        <ScrollView contentContainerStyle={styles.resultContent}>
          <MaterialCommunityIcons
            name="alert-octagon-outline"
            size={56}
            color={Colors.red}
          />
          <Text style={styles.resultTitleDanger}>
            Kitchen and bar were NOT notified
          </Text>
          <Text style={styles.resultSubtitle}>{sentTableLabel}</Text>
          {outcome.orderNumber != null ? (
            <Text style={styles.orderNumberDanger}>
              Order #{outcome.orderNumber}
            </Text>
          ) : null}
          <View style={styles.dangerPanel}>
            <Text style={styles.dangerText}>{outcome.message}</Text>
          </View>
          <Text style={styles.resultHint}>
            Do not send this round again — it is already on the tab and would be
            charged twice.
          </Text>
          <Pressable style={styles.primaryButton} onPress={backToFloor}>
            <Text style={styles.primaryButtonText}>Back to Floor</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (!table) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>
          No table is open on this device. Go back to the floor and pick one.
        </Text>
        <Pressable style={styles.primaryButton} onPress={backToFloor}>
          <Text style={styles.primaryButtonText}>Back to Floor</Text>
        </Pressable>
      </View>
    );
  }

  const count = basketCount(lines);
  const subtotal = basketSubtotal(lines);
  const heading = table.tableName
    ? `Table ${table.tableNumber} · ${table.tableName}`
    : `Table ${table.tableNumber}`;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          disabled={sending}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <Text style={styles.screenTitle} numberOfLines={1}>
          Review · {heading}
        </Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView contentContainerStyle={styles.reviewContent}>
        {outcome?.kind === 'tab_closed' ? (
          <View style={styles.warnPanel}>
            <Text style={styles.warnTitle}>This table was closed</Text>
            <Text style={styles.warnText}>{outcome.message}</Text>
            <Pressable
              style={styles.warnButton}
              onPress={() =>
                navigation.replace('ServiceOpenTable', {
                  tableId: table.tableId,
                  tableNumber: table.tableNumber,
                  tableName: table.tableName,
                })
              }>
              <Text style={styles.warnButtonText}>Re-open this table</Text>
            </Pressable>
          </View>
        ) : null}

        {outcome?.kind === 'gone' || outcome?.kind === 'error' ? (
          <View style={styles.warnPanel}>
            <Text style={styles.warnText}>{outcome.message}</Text>
          </View>
        ) : null}

        {lines.map(line => (
          <View key={line.lineId} style={styles.reviewRow}>
            <Text style={styles.reviewQty}>{line.quantity}×</Text>
            <View style={styles.reviewMain}>
              <Text style={styles.reviewName}>{line.name}</Text>
              {line.note.trim() ? (
                <Text style={styles.reviewNote}>{line.note.trim()}</Text>
              ) : null}
            </View>
            <Text style={styles.reviewAmount}>
              {formatMoney(line.unitPrice * line.quantity)}
            </Text>
          </View>
        ))}

        <Text style={styles.instructionsLabel}>Order note (optional)</Text>
        <TextInput
          style={styles.instructionsInput}
          value={orderInstructions}
          onChangeText={setOrderInstructions}
          placeholder="e.g. allergy: shellfish"
          placeholderTextColor={Colors.textMuted}
          multiline
          maxLength={280}
        />
        <Text style={styles.instructionsHint}>
          Order-level only. Use the per-item notes to say which dish is which.
        </Text>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>
            {count} {count === 1 ? 'item' : 'items'}
          </Text>
          <Text style={styles.totalValue}>{formatMoney(subtotal)}</Text>
        </View>
        <Text style={styles.advisoryHint}>
          The final amount is priced by the server from the menu.
        </Text>
      </ScrollView>

      <View style={[styles.bottomBar, {paddingBottom: insets.bottom + Spacing.sm}]}>
        <Pressable
          style={[styles.secondaryButton, sending && styles.buttonDisabled]}
          onPress={() => navigation.goBack()}
          disabled={sending}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
        <Pressable
          style={[styles.sendButton, sending && styles.buttonDisabled]}
          onPress={handleSend}
          disabled={sending}>
          {sending ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <Text style={styles.primaryButtonText}>
              {outcome ? 'Send Again' : 'Send Round'}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: Colors.surface},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
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
  reviewContent: {padding: Spacing.md, paddingBottom: Spacing.xl},
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  reviewQty: {
    ...Typography.body,
    fontWeight: '800',
    color: Colors.textPrimary,
    minWidth: 34,
  },
  reviewMain: {flex: 1},
  reviewName: {...Typography.body, fontWeight: '600', color: Colors.textPrimary},
  reviewNote: {
    ...Typography.small,
    color: Colors.orange,
    fontWeight: '600',
    marginTop: 2,
  },
  reviewAmount: {...Typography.body, fontWeight: '700', color: Colors.textPrimary},
  instructionsLabel: {
    ...Typography.small,
    fontWeight: '700',
    color: Colors.textSecondary,
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
  },
  instructionsInput: {
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: Spacing.md,
    minHeight: 72,
    textAlignVertical: 'top',
    ...Typography.small,
    color: Colors.textPrimary,
  },
  instructionsHint: {
    ...Typography.tiny,
    color: Colors.textMuted,
    marginTop: Spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  totalLabel: {...Typography.subheading, color: Colors.textSecondary},
  totalValue: {...Typography.heading, color: Colors.textPrimary},
  advisoryHint: {
    ...Typography.tiny,
    color: Colors.textMuted,
    marginTop: Spacing.xs,
  },
  bottomBar: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  secondaryButton: {
    paddingVertical: 16,
    paddingHorizontal: Spacing.lg,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  secondaryButtonText: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  sendButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  buttonDisabled: {opacity: 0.6},
  primaryButton: {
    marginTop: Spacing.lg,
    paddingVertical: 16,
    paddingHorizontal: Spacing.xl,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  primaryButtonText: {color: Colors.white, ...Typography.subheading},
  resultContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  resultTitle: {...Typography.heading, color: Colors.textPrimary},
  resultTitleDanger: {
    ...Typography.heading,
    color: Colors.red,
    textAlign: 'center',
  },
  resultSubtitle: {...Typography.body, color: Colors.textSecondary},
  orderNumber: {fontSize: 30, fontWeight: '800', color: Colors.textPrimary},
  orderNumberDanger: {fontSize: 30, fontWeight: '800', color: Colors.red},
  resultBody: {...Typography.body, color: Colors.textSecondary},
  resultHint: {
    ...Typography.small,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  unroutedPanel: {
    flexDirection: 'row',
    gap: Spacing.sm,
    backgroundColor: Colors.amberLight,
    borderWidth: 1,
    borderColor: Colors.amber,
    borderRadius: 12,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  unroutedText: {flex: 1, ...Typography.small, color: Colors.amber},
  dangerPanel: {
    backgroundColor: Colors.redLight,
    borderWidth: 1.5,
    borderColor: Colors.red,
    borderRadius: 12,
    padding: Spacing.md,
    marginTop: Spacing.md,
    alignSelf: 'stretch',
  },
  dangerText: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.red,
    textAlign: 'center',
  },
  warnPanel: {
    backgroundColor: Colors.amberLight,
    borderWidth: 1,
    borderColor: Colors.amber,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  warnTitle: {...Typography.subheading, color: Colors.amber},
  warnText: {...Typography.small, color: Colors.amber},
  warnButton: {
    backgroundColor: Colors.amber,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  warnButtonText: {color: Colors.white, ...Typography.body, fontWeight: '700'},
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  errorText: {...Typography.body, color: Colors.red, textAlign: 'center'},
});
