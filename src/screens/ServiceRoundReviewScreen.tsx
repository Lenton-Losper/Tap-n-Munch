import React, {useCallback, useEffect, useRef, useState} from 'react';
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
  getTabLines,
  RoundKeyMismatchError,
  RoundLinesNotWrittenError,
  RoundOutcomeUnknownError,
  RoundOutOfStockError,
  RoundPersistedItem,
  RoundPricingRefusedError,
  RoundResult,
  sendRound,
  StationCounts,
  TabNotOpenError,
} from '../lib/api';
import * as RoundCopy from '../constants/roundSendCopy';
import {findRoundOnTab} from '../lib/roundOutcome';
import {
  basketCount,
  basketSubtotal,
  buildRoundItems,
  outOfStockLineIds,
  roundLineLabel,
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
  /**
   * C4 duplicate: true. `items` is the SERVER's list — from the response, or read off the table
   * when an older server sent none. Null while that read is in progress or if it failed.
   */
  | {kind: 'duplicate'; result: RoundResult; items: RoundPersistedItem[] | null}
  | {
      kind: 'key_mismatch';
      message: string;
      orderNumber: number | null;
      items: RoundPersistedItem[];
    }
  | {kind: 'lines_not_written'; message: string; orderNumber: number | null}
  | {kind: 'tab_closed'; message: string}
  | {kind: 'gone'; message: string}
  | {kind: 'pricing'; message: string; unavailable: string[]}
  /** The round may be on the tab. The basket is locked; only Retry and Check are offered. */
  | {kind: 'unknown'; message: string}
  | {kind: 'error'; message: string};

/** What "Check the table" found, shown under the unknown-outcome panel. */
type CheckResult =
  | {kind: 'found'; orderNumber: number; items: RoundPersistedItem[]}
  | {kind: 'not_found'}
  | {kind: 'failed'};

function itemsOfOrder(
  order: {lines: {name_snapshot: string; quantity: number; is_voided: boolean}[]},
): RoundPersistedItem[] {
  return order.lines
    .filter(line => !line.is_voided)
    .map(line => ({name: line.name_snapshot, quantity: line.quantity}));
}

export default function ServiceRoundReviewScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {
    table,
    lines,
    idempotencyKey,
    orderInstructions,
    setOrderInstructions,
    roundLock,
    lockRound,
    unlockRound,
    clearBasket,
    endSession,
  } = useServiceSession();

  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  /** Snapshotted before endSession clears the context, so the panel survives the drop. */
  const [sentTableLabel, setSentTableLabel] = useState('');
  /** When THIS round was first sent. Survives retries; only narrows Check the table's search. */
  const firstSentAtRef = useRef<number | null>(null);
  /**
   * A4 (RC sprint 2026-09-30). THE SYNCHRONOUS RE-ENTRANCY GUARD ON SEND. `sending` is React state,
   * which has not re-rendered between two presses dispatched in the same batch, so a double tap
   * reached POST /rounds twice under the same key. Two CONCURRENT same-key requests are not a safe
   * replay: the route's line write is checked-then-written with no unique index behind it, so both
   * can write the round's lines and the kitchen gets it twice. Same fix as PaymentScreen's
   * `cardPaymentInFlight`: claimed before the first await, released in the `finally`.
   */
  const sendInFlightRef = useRef(false);

  /**
   * NO WAY OFF THIS SCREEN WHILE THE ROUND IS IN DOUBT, hardware back included. Leaving would end
   * the session — dropping the key — and the waiter would rebuild the round under a new one: two
   * rounds on the tab if the first did land. Also blocked mid-send.
   */
  const holdRef = useRef(false);
  holdRef.current = sending || roundLock != null;
  useEffect(() => {
    const addListener = (navigation as {addListener?: Props['navigation']['addListener']})
      .addListener;
    if (typeof addListener !== 'function') {
      return undefined;
    }
    return navigation.addListener('beforeRemove', event => {
      if (holdRef.current) {
        event.preventDefault();
      }
    });
  }, [navigation]);

  const backToFloor = useCallback(() => {
    endSession();
    navigation.popToTop();
  }, [endSession, navigation]);

  const handleSend = useCallback(async () => {
    if (!table || sendInFlightRef.current) {
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

    sendInFlightRef.current = true;
    setSending(true);
    setOutcome(null);
    setCheck(null);
    if (firstSentAtRef.current == null) {
      firstSentAtRef.current = Date.now();
    }

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
          // Reused verbatim on every retry of THIS round, and the basket cannot change between
          // retries (roundLock). A repeat returns the original order with duplicate: true.
          idempotencyKey,
        },
        token,
      );

      // A definite answer: release the lock BEFORE endSession/clearBasket, which it would refuse.
      unlockRound();
      // THE SEND-DROPS-THE-PIN-SESSION RULE. On any 2xx the held identity goes, immediately, so
      // the next table costs a PIN again. The round itself is attributed server-side from the
      // tab, so nothing about this affects who gets credit for what was just sent.
      setSentTableLabel(label);
      endSession();

      if (!result.duplicate) {
        setOutcome({kind: 'sent', result});
        return;
      }

      /**
       * ALREADY SENT. Never a fresh green "Round sent": after an edit those two differ, and the
       * basket this screen was showing is NOT necessarily what the kitchen has. Show the SERVER's
       * items — from the response, or read off the table when an older server sent none.
       */
      if (result.persisted_items.length > 0) {
        setOutcome({kind: 'duplicate', result, items: result.persisted_items});
        return;
      }
      setOutcome({kind: 'duplicate', result, items: null});
      try {
        const payload = await getTabLines(table.tabId, token);
        const order = payload.orders.find(o => o.order_id === result.order_id);
        setOutcome({kind: 'duplicate', result, items: order ? itemsOfOrder(order) : []});
      } catch {
        setOutcome({kind: 'duplicate', result, items: []});
      }
    } catch (err) {
      if (err instanceof RoundOutcomeUnknownError) {
        // THE LOCK. Nothing about this round may change until the server gives a definite answer.
        lockRound({kind: err.kind, sentAt: firstSentAtRef.current ?? Date.now()});
        setOutcome({kind: 'unknown', message: err.message});
        return;
      }

      // Everything below is a DEFINITE answer about this round, so the lock goes first.
      unlockRound();

      if (err instanceof RoundKeyMismatchError) {
        // Nothing new was created; the ORIGINAL is on the tab. The basket is not it.
        setSentTableLabel(label);
        endSession();
        setOutcome({
          kind: 'key_mismatch',
          message: err.message,
          orderNumber: err.orderNumber,
          items: err.items,
        });
        return;
      }

      if (err instanceof RoundPricingRefusedError) {
        // Nothing created. Not retried, automatically or by a button: the same body fails again.
        setOutcome({kind: 'pricing', message: err.message, unavailable: err.unavailableItems});
        return;
      }

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
      sendInFlightRef.current = false;
      setSending(false);
    }
  }, [
    clearBasket,
    endSession,
    idempotencyKey,
    lines,
    lockRound,
    navigation,
    orderInstructions,
    table,
    unlockRound,
  ]);

  /**
   * Read the table and look for this round. A HINT, never a resolution — see lib/roundOutcome.
   * The lock stays; the waiter still resolves it with Retry, which cannot double the round.
   */
  const handleCheckTable = useCallback(async () => {
    if (!table || checking) {
      return;
    }
    setChecking(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('no token');
      }
      const payload = await getTabLines(table.tabId, token);
      const sentAt = roundLock?.sentAt ?? firstSentAtRef.current ?? Date.now();
      const found = findRoundOnTab(
        payload,
        lines.map(line => ({name: line.name, quantity: line.quantity})),
        (Date.now() - sentAt) / 1000,
      );
      setCheck(
        found
          ? {kind: 'found', orderNumber: found.order_number, items: itemsOfOrder(found)}
          : {kind: 'not_found'},
      );
    } catch {
      setCheck({kind: 'failed'});
    } finally {
      setChecking(false);
    }
  }, [checking, lines, roundLock, table]);

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

  if (outcome?.kind === 'duplicate' || outcome?.kind === 'key_mismatch') {
    const mismatch = outcome.kind === 'key_mismatch';
    const orderNumber = mismatch ? outcome.orderNumber : outcome.result.order_number;
    return (
      <View style={[styles.wrapper, {paddingTop: insets.top}]}>
        <ScrollView contentContainerStyle={styles.resultContent}>
          <MaterialCommunityIcons
            name={mismatch ? 'alert-outline' : 'information-outline'}
            size={56}
            color={Colors.amber}
          />
          <Text style={styles.resultTitleWarn} testID={`round-${outcome.kind}-title`}>
            {mismatch ? RoundCopy.ROUND_MISMATCH_TITLE : RoundCopy.ROUND_ALREADY_SENT_TITLE}
          </Text>
          <Text style={styles.resultSubtitle}>{sentTableLabel}</Text>
          {orderNumber != null ? (
            <Text style={styles.orderNumber}>Order #{orderNumber}</Text>
          ) : null}
          <Text style={styles.resultHint}>
            {mismatch ? RoundCopy.ROUND_MISMATCH_BODY : RoundCopy.ROUND_ALREADY_SENT_BODY}
          </Text>
          {/* The SERVER's items. Never the basket: after an edit the two are different rounds. */}
          <View style={styles.serverItems} testID="round-server-items">
            {outcome.items == null ? (
              <ActivityIndicator color={Colors.primary} />
            ) : outcome.items.length === 0 ? (
              <Text style={styles.warnText}>{RoundCopy.ROUND_ITEMS_UNAVAILABLE}</Text>
            ) : (
              outcome.items.map((item, index) => (
                <Text key={`${item.name}-${index}`} style={styles.serverItemText}>
                  {item.quantity}× {item.name}
                </Text>
              ))
            )}
          </View>
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
  /** The round may be on the tab: only Retry and Check are offered, and nothing is editable. */
  const locked = roundLock != null;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          testID="round-back-arrow"
          disabled={sending || locked}>
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

        {/* C5. Nothing was created. No retry button: the same basket is refused the same way. */}
        {outcome?.kind === 'pricing' ? (
          <View style={styles.warnPanel} testID="round-pricing-refused">
            <Text style={styles.warnTitle}>{RoundCopy.ROUND_PRICING_TITLE}</Text>
            <Text style={styles.warnText}>{outcome.message}</Text>
            <Text style={styles.warnText}>{RoundCopy.ROUND_PRICING_BODY}</Text>
            {outcome.unavailable.map((name, index) => (
              <Text key={`${name}-${index}`} style={styles.warnText}>
                • {name}
              </Text>
            ))}
          </View>
        ) : null}

        {/* THE LOCK. The round may already be with the kitchen. */}
        {locked ? (
          <View style={styles.warnPanel} testID="round-unknown-outcome">
            <Text style={styles.warnTitle}>{RoundCopy.ROUND_UNKNOWN_TITLE}</Text>
            <Text style={styles.warnText}>{RoundCopy.ROUND_UNKNOWN_BODY}</Text>
            {outcome?.kind === 'unknown' ? (
              <Text style={styles.warnText}>{outcome.message}</Text>
            ) : null}
            {check?.kind === 'found' ? (
              <View testID="round-check-found">
                <Text style={styles.warnText}>
                  {RoundCopy.ROUND_CHECK_FOUND.replace('{number}', String(check.orderNumber))}
                </Text>
                {check.items.map((item, index) => (
                  <Text key={`${item.name}-${index}`} style={styles.warnText}>
                    {item.quantity}× {item.name}
                  </Text>
                ))}
              </View>
            ) : check?.kind === 'not_found' ? (
              <Text style={styles.warnText} testID="round-check-not-found">
                {RoundCopy.ROUND_CHECK_NOT_FOUND}
              </Text>
            ) : check?.kind === 'failed' ? (
              <Text style={styles.warnText} testID="round-check-failed">
                {RoundCopy.ROUND_CHECK_FAILED}
              </Text>
            ) : null}
            <Pressable
              style={[styles.warnButton, (checking || sending) && styles.buttonDisabled]}
              testID="round-check-table"
              disabled={checking || sending}
              onPress={handleCheckTable}>
              {checking ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Text style={styles.warnButtonText}>{RoundCopy.ROUND_CHECK_TABLE}</Text>
              )}
            </Pressable>
          </View>
        ) : null}

        {lines.map(line => (
          <View key={line.lineId} style={styles.reviewRow}>
            <Text style={styles.reviewQty}>{line.quantity}×</Text>
            <View style={styles.reviewMain}>
              <Text style={styles.reviewName}>{roundLineLabel(line)}</Text>
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
          // A5: not while the send is out either. The note rides in the body, the route does not
          // compare it on a replay, so a note typed mid-send would be dropped by the retry's replay.
          editable={!locked && !sending}
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
        {/* No Back while locked: leaving is how the key gets dropped and the round rebuilt. */}
        {locked ? null : (
          <Pressable
            style={[styles.secondaryButton, sending && styles.buttonDisabled]}
            onPress={() => navigation.goBack()}
            testID="round-back"
            disabled={sending}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
        )}
        {outcome?.kind === 'pricing' ? (
          // The basket has to change before this can go. No resend of the same refused body.
          <Pressable
            style={styles.sendButton}
            testID="round-pricing-fix"
            onPress={() => navigation.goBack()}>
            <Text style={styles.primaryButtonText}>{RoundCopy.ROUND_PRICING_FIX}</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.sendButton, sending && styles.buttonDisabled]}
            testID="round-send"
            onPress={handleSend}
            disabled={sending}>
            {sending ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {locked
                  ? RoundCopy.ROUND_RETRY_SAME
                  : outcome
                  ? 'Send Again'
                  : 'Send Round'}
              </Text>
            )}
          </Pressable>
        )}
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
  resultTitleWarn: {
    ...Typography.heading,
    color: Colors.amber,
    textAlign: 'center',
  },
  serverItems: {
    alignSelf: 'stretch',
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  serverItemText: {...Typography.body, fontWeight: '600', color: Colors.textPrimary},
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
