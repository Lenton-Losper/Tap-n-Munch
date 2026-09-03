import React, {useCallback, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import AmendLineSheet from '../components/AmendLineSheet';
import CloseTableAction from '../components/CloseTableAction';
import {canAmendLine} from '../lib/amendTabLines';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/serviceCopy';
import {ApiRequestError, getTabLines, getTablesWithMeta} from '../lib/api';
import {
  formatAge,
  itemCount,
  lineDisplayState,
  partialProgress,
  cookedProgress,
  TabLine,
  TabLinesPayload,
  tabRunningTotal,
} from '../lib/tabLines';
import {
  amountOwed,
  canOfferSettle,
  deriveTabSettlementState,
  TabSettlementState,
} from '../lib/tabSettlement';
import {getTerminalToken} from '../lib/storage';
import {subscribeLineChangeInvalidation, resolveRestaurantId} from '../lib/realtimeInvalidation';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';
import {TableWithTab} from '../types';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceTable'>;

/**
 * The SAFETY NET, not the transport. Real synchronization is
 * subscribeLineChangeInvalidation (src/lib/realtimeInvalidation.ts) — a bar/kitchen bump reaches
 * this screen through that within about a second, the same way the web boards' own Realtime
 * channel does. This poll exists only for the case Realtime cannot cover: a broadcast that never
 * lands (dropped, or sent while this screen's channel was mid-reconnect and not yet counted as
 * `everUp`). 45s, not the 15s this used to be — 15s was the mitigation before the transport was
 * fixed; a slow reconciliation poll on top of a working push channel does not need to be fast,
 * see the architecture note above `load`'s useFocusEffect below.
 */
const TABLE_POLL_INTERVAL_MS = 45_000;

function formatMoney(amount: number): string {
  return `NAD ${amount.toFixed(2)}`;
}

/**
 * One fulfilment line.
 *
 * The chip reads the SERVER's verdict — `is_ready` and, since the collected split, `is_collected`.
 * It is never recomputed from kitchen_state/bar_state. The station screens and this screen must
 * agree about what "ready" means, and they only do so if exactly one place decides it.
 */
function LineRow({line, onEdit}: {line: TabLine; onEdit?: (l: TabLine) => void}) {
  /**
   * ONE state, from one place. This was a ternary on is_voided / is_ready, which since the
   * server's `collected` split rendered picked-up food as "Being made" — see lineDisplayState.
   *
   * Since the owner's 2026-09-01 sign-off, 'collected' says COLLECTED in its own words rather
   * than borrowing the Ready chip, and a half-finished `both` line names the station still
   * working instead of collapsing to "Being made".
   *
   * `partialProgress` is display only and is consulted ONLY when the server has already said the
   * line is neither ready nor collected — it can never make a line look readier than the server
   * says it is.
   */
  const display = lineDisplayState(line);
  /**
   * Partial detail is consulted for `cooked` as well as `making`. A half-voided line sits in the
   * server's outstanding bucket and may carry a cooked half at the same time, and "Kitchen
   * cancelled" is the more important of the two facts: a waiter can act on a cancellation, whereas
   * "Nearly ready" only tells them to keep waiting for something that is not coming.
   */
  const partial =
    display === 'making' || display === 'cooked' ? partialProgress(line) : null;
  const chip =
    display === 'voided'
      ? Copy.TABLE_LINE_VOIDED_CHIP
      : display === 'collected'
      ? Copy.TABLE_LINE_COLLECTED_CHIP
      : display === 'ready'
      ? Copy.TABLE_LINE_READY_CHIP
      : partial === 'kitchen_cancelled_bar_ready'
      ? Copy.TABLE_LINE_KITCHEN_CANCELLED_BAR_READY
      : partial === 'bar_cancelled_kitchen_ready'
      ? Copy.TABLE_LINE_BAR_CANCELLED_KITCHEN_READY
      : partial === 'kitchen_cancelled'
      ? Copy.TABLE_LINE_KITCHEN_CANCELLED
      : partial === 'bar_cancelled'
      ? Copy.TABLE_LINE_BAR_CANCELLED
      : partial === 'kitchen_ready'
      ? Copy.TABLE_LINE_KITCHEN_READY_BAR_WAITING
      : partial === 'bar_ready'
      ? Copy.TABLE_LINE_BAR_READY_KITCHEN_WAITING
      : display === 'cooked'
      ? Copy.TABLE_LINE_COOKED_CHIP
      : Copy.TABLE_LINE_WAITING_CHIP;

  /**
   * Tappable ONLY while the amend window is open. A line the kitchen has started is not pressable
   * at all, rather than opening a sheet that could only say no — the affordance is the window.
   *
   * The server still decides. It can refuse a line this thought was open, because the kitchen may
   * tap Cooked between this render and the waiter's press, and that is exactly why refusals come
   * back per line.
   */
  const amendable = onEdit != null && canAmendLine(line);

  return (
    <Pressable
      disabled={!amendable}
      onPress={amendable ? () => onEdit!(line) : undefined}
      style={[styles.lineRow, line.is_voided && styles.lineRowVoided]}>
      <Text style={styles.lineQty}>{line.quantity}×</Text>
      <View style={styles.lineMain}>
        <Text
          style={[styles.lineName, line.is_voided && styles.lineNameVoided]}
          numberOfLines={2}>
          {line.name_snapshot}
        </Text>
        {line.line_note ? (
          <Text style={styles.lineNote} numberOfLines={2}>
            {line.line_note}
          </Text>
        ) : null}
        {/* Not merely late — no station ever received it. Nobody is making this. */}
        {line.unrouted && !line.is_voided ? (
          <View style={styles.unroutedRow}>
            <MaterialCommunityIcons
              name="alert-octagon-outline"
              size={16}
              color={Colors.red}
            />
            <Text style={styles.unroutedText}>
              {Copy.TABLE_NOT_SENT_WARNING}
            </Text>
          </View>
        ) : null}
      </View>
      {/*
        'collected' now says COLLECTED (owner sign-off 2026-09-01) and keeps the ready chip's
        shape without its fill, so the rounds a waiter still has to walk for are the only green on
        the screen. A partial `both` line names the station still working and is allowed to shrink
        rather than push the dish name off the row.
      */}
      <View
        style={[
          styles.lineChip,
          display === 'voided'
            ? styles.lineChipVoided
            : display === 'making' || display === 'cooked'
            ? styles.lineChipWaiting
            : styles.lineChipReady,
          display === 'collected' && styles.lineChipCollected,
          partial != null && styles.lineChipPartial,
        ]}
        testID={partial ? `line-chip-partial-${partial}` : `line-chip-${display}`}>
        <Text
          style={[
            styles.lineChipText,
            display === 'voided'
              ? styles.lineChipTextVoided
              : display === 'making' || display === 'cooked'
              ? styles.lineChipTextWaiting
              : styles.lineChipTextReady,
            display === 'collected' && styles.lineChipTextCollected,
          ]}
          numberOfLines={1}>
          {chip}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ServiceTableScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {
    tableId,
    tableNumber,
    tableName,
    tabId,
    ownerName,
    adoptedExistingTab,
    handedOverFrom,
  } = route.params;
  const {table: sessionTable, lines: sessionLines} = useServiceSession();

  /**
   * The adoption / handover notice, dismissible.
   *
   * Held in state rather than read from params on each render so that dismissing it sticks, and
   * seeded once from the params the open screen replaced this screen with. Handover outranks
   * adoption: taking a table off a colleague is the more consequential of the two, and only one
   * banner fits above the bill.
   */
  const [notice, setNotice] = useState<string | null>(() => {
    if (handedOverFrom?.name) {
      return Copy.TABLE_HANDED_OVER_NOTICE.replace(
        '{name}',
        handedOverFrom.name,
      );
    }
    return adoptedExistingTab ? Copy.TABLE_ADOPTED_NOTICE : null;
  });

  const [payload, setPayload] = useState<TabLinesPayload | null>(null);
  /**
   * THE MONEY HALF OF THIS SCREEN, from `GET /api/terminal/tables`.
   *
   * The lines payload this screen was built on carries no payment information whatsoever — see
   * the block comment on lib/tabSettlement. Without this second read the screen cannot tell a
   * paid tab from an unpaid one, which is why it could only ever offer Add Round.
   *
   * Held separately from `payload` and allowed to be null on its own, because a failure to read
   * the money must NOT blank the bill or the lines. It withdraws the settle control and says the
   * payment state is unknown; it does not pretend nobody has paid.
   */
  const [moneyTable, setMoneyTable] = useState<TableWithTab | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** The line whose amend sheet is open, or null. Holding the LINE, not an id, so the sheet
   *  renders the dish the waiter actually tapped rather than re-finding it in a list that may
   *  have refreshed underneath. */
  const [editingLine, setEditingLine] = useState<TabLine | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Declared here, above the effect that clears it — see handleSettle for what it guards. */
  const navigatingToSettle = useRef(false);

  /**
   * The five-way settlement state, derived on EVERY RENDER from the payload rather than stored.
   * A stored payment state is a fact that was true once and goes stale silently — the same rule
   * deriveTableFlag already follows for readiness.
   */
  const settlementState: TabSettlementState = deriveTabSettlementState(moneyTable);
  const owed = amountOwed(moneyTable);
  const settleOffered = canOfferSettle(settlementState);

  const load = useCallback(
    async (pull = false) => {
      if (pull) {
        setRefreshing(true);
      }
      try {
        const token = await getTerminalToken();
        if (!token) {
          throw new Error(
            'Terminal session not found. Re-activate this terminal.',
          );
        }
        setPayload(await getTabLines(tabId, token));
        setError(null);

        /**
         * Money read, deliberately AFTER the lines and deliberately in its own try/catch.
         *
         * Two separate calls rather than Promise.all: the lines are what this screen is for, and
         * a tables call that 500s must not cost the waiter the view of their table. A failure
         * here clears moneyTable, which drives the state to 'unknown' and takes the settle
         * control away — the fail-closed direction.
         */
        try {
          const {tables} = await getTablesWithMeta(token);
          setMoneyTable(tables.find(t => t.id === tableId) ?? null);
        } catch (moneyErr) {
          console.warn('[ServiceTable] payment state unavailable:', moneyErr);
          setMoneyTable(null);
        }
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          // Restaurant-scoped: 404 is also what another venue's tab returns. Either way this
          // device has no business with it, and the grid is the honest place to send them back to.
          setError(Copy.TABLE_LOAD_FAILED);
        } else {
          setError(
            err instanceof Error ? err.message : Copy.TABLE_LOAD_FAILED,
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [tabId, tableId],
  );

  // Refetch on every focus, so returning from a round shows the lines it just created —
  // and, now, so returning from taking payment shows the money that was taken.
  //
  // ============================================================================================
  // WHY THIS IS Realtime FIRST, POLL SECOND — NOT THE 15s POLL THIS SCREEN SHIPPED WITH FIRST
  // ============================================================================================
  //
  // `line.is_ready` is read straight from another device's action (a station tapping Cooked, or
  // the bar tapping Out) — see LineRow's docblock. The first fix for "I tapped Out and the
  // terminal still says Being made" was a 15s poll, which worked but was a mitigation: staff could
  // still be looking at a stale chip for up to 15 seconds, and it re-asked the server every 15
  // seconds whether anyone was looking or not.
  //
  // subscribeLineChangeInvalidation (src/lib/realtimeInvalidation.ts) is the actual fix — a
  // restaurant-scoped Realtime Broadcast channel the server sends on immediately after any real
  // kitchen_state/bar_state write, so a bump reaches this screen in about the time a websocket
  // frame takes, not up to a whole poll interval later. TABLE_POLL_INTERVAL_MS (now 45s) is what
  // is left for the case Realtime cannot cover — a dropped broadcast, a channel mid-reconnect —
  // and 45s is fine for that because it is a safety net, not the transport.
  useFocusEffect(
    useCallback(() => {
      navigatingToSettle.current = false;
      load();

      let cancelled = false;
      let unsubscribeRealtime: (() => void) | null = null;

      // resolveRestaurantId, not getRestaurantId directly: recovers from GET /api/terminal/me
      // when storage never got it written -- see its own docblock. Re-run on every focus, same
      // as the rest of this effect, so a device that failed to resolve it once is not stuck that
      // way permanently.
      void resolveRestaurantId().then((restaurantId) => {
        if (cancelled) return;
        // `load(false)`: a background invalidation must not flash the pull-to-refresh spinner.
        unsubscribeRealtime = subscribeLineChangeInvalidation(restaurantId, () => load(false));
      });

      const interval = setInterval(() => load(false), TABLE_POLL_INTERVAL_MS);
      return () => {
        cancelled = true;
        unsubscribeRealtime?.();
        clearInterval(interval);
      };
    }, [load]),
  );

  /**
   * Add Round.
   *
   * The waiter reached this screen by tapping an open table, which costs NO PIN — reading a table
   * is not an attributable act. Adding to it is, so the PIN is collected here, and collecting it
   * runs the ADOPT path: POST /tables/{id}/open answers `already_open: true`, hands this device
   * the existing tab, makes the waiter owner if nobody is, and never creates a second tab.
   *
   * When the session already holds THIS tab, the PIN was paid moments ago on the way in and is not
   * asked for twice.
   */
  /**
   * SETTLE.
   *
   * The control the waiter table view has never had. It hands off to the settle view, which is
   * the SAME screen and the same code path the terminal already takes money through today —
   * `runSettle` / `runCashSettle` in TableDetailScreen, with its Finatic ambiguity resolution,
   * its `completePaymentReliably` failure reporting, and its server-gated cash affordances.
   *
   * NOT REIMPLEMENTED HERE, AND THAT IS THE POINT. A second card-payment flow written under
   * deadline is how a customer gets charged twice. There is one flow that takes money on this
   * device, it is the one with the #326/#327 fixes in it, and this screen routes into it rather
   * than growing a rival.
   *
   * That screen offers BOTH shapes of settle: "Settle Entire Tab" and, per order, "Settle
   * Selected". Riviera's split bill is the second of those. Note the granularity honestly: the
   * server settles WHOLE ORDERS (`order_ids`, and it recomputes the amount from those orders'
   * totals), so a bill splits by round, never by individual dish.
   *
   * `moneyTable` is passed rather than re-fetched by the destination, because it is the object
   * that route requires and this screen has just read it. The destination refreshes it on focus
   * regardless.
   */
  const handleSettle = useCallback(() => {
    /**
     * DOUBLE-TAP GUARD.
     *
     * Two taps on a native-stack button push the destination TWICE, leaving a second settle
     * screen underneath the first with its own copy of the tab. Money is not taken here, so this
     * guard is not the one that prevents a double charge — the settle screen's own in-flight
     * flag and the server's atomic claim (which answers 409 ALREADY_PAID to the second attempt)
     * are. This one prevents the waiter ever being shown two of them.
     *
     * Cleared on focus, so coming back from the settle screen re-arms the button.
     */
    if (navigatingToSettle.current) {
      return;
    }
    if (!moneyTable || !canOfferSettle(settlementState)) {
      return;
    }
    navigatingToSettle.current = true;
    navigation.navigate('TableDetail', {table: moneyTable});
  }, [moneyTable, navigation, settlementState]);

  const handleAddRound = useCallback(() => {
    if (sessionTable && sessionTable.tabId === tabId) {
      navigation.navigate('ServiceRound');
      return;
    }
    navigation.navigate('ServiceOpenTable', {
      tableId,
      tableNumber,
      tableName,
      next: 'round',
    });
  }, [navigation, sessionTable, tabId, tableId, tableName, tableNumber]);

  const heading = tableName
    ? `Table ${tableNumber} · ${tableName}`
    : `Table ${tableNumber}`;

  const total = tabRunningTotal(payload);
  const summary = payload?.summary;
  const hasLines = payload?.has_lines === true;
  const items = itemCount(payload);
  const cooked = cookedProgress(payload);

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
        <View style={styles.titleBlock}>
          <Text style={styles.screenTitle} numberOfLines={1}>
            {heading}
          </Text>
          {ownerName ? (
            <Text style={styles.screenSubtitle} numberOfLines={1}>
              {ownerName}
            </Text>
          ) : null}
        </View>
        <View style={styles.backButton} />
      </View>

      {loading && !payload ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={Colors.primary}
            />
          }>
          {error ? (
            <View style={styles.errorPanel}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable style={styles.retryButton} onPress={() => load()}>
                <Text style={styles.retryButtonText}>{Copy.TABLE_RETRY}</Text>
              </Pressable>
            </View>
          ) : null}

          {notice ? (
            <Pressable
              style={styles.noticeBanner}
              onPress={() => setNotice(null)}>
              <MaterialCommunityIcons
                name="account-switch-outline"
                size={20}
                color={Colors.blue}
              />
              <Text style={styles.noticeBannerText}>{notice}</Text>
              <MaterialCommunityIcons
                name="close"
                size={18}
                color={Colors.textMuted}
              />
            </Pressable>
          ) : null}

          {/* THE RUNNING BILL, from the payload's own tab.total — the server's figure, never a
              client-side sum of the lines, which would disagree the moment a void or a discount
              exists. */}
          <View style={styles.billPanel}>
            <Text style={styles.billLabel}>{Copy.TABLE_BILL_LABEL}</Text>
            <Text style={styles.billAmount}>{formatMoney(total)}</Text>
          </View>

          {/*
            PAYMENT STATE. Five distinct states, five distinct chips, and in particular
            'fully_paid' and 'closed' are NOT the same chip — a tab can be paid to the last cent
            and still be open for another round, and conflating the two is what makes staff
            believe payment ended the session.

            SIGNED by the owner 2026-08-28, verbatim. Each state names BOTH the money and the session -- "paid in full" against "table still open" vs "table closed" is what carries the paid-is-not-closed rule to a waiter. The unreadable state deliberately says nothing about the money: a blank or a soft message there reads as nothing owed, which is the trap.
          */}
          <View style={styles.paymentStateRow}>
            {settlementState === 'unpaid' ? (
              <View style={[styles.stateChip, styles.stateChipUnpaid]}>
                <Text style={[styles.stateChipText, styles.stateChipTextUnpaid]}>
                  {'Nothing paid yet · table open'}
                </Text>
              </View>
            ) : null}
            {/*
              ITS OWN CHIP, NOT THE UNPAID ONE. Signed by the owner 2026-08-28.

              This shared the unpaid chip in 2.09 — "Nothing paid yet · table open" — which was
              true but incomplete, and the owner caught what that costs: a waiter reading "nothing
              paid yet" on a cancelled tab will try to TAKE PAYMENT for food that has no order
              behind it. The sentence has to say what actually happened, not just that no money
              arrived.

              The state exists because a tab whose orders were all cancelled has nothing owed and
              nothing paid, and used to fall into 'fully_paid' — Digi Cofee Table 1, 2026-08-28,
              NAD 19 already cooked, the screen saying the bill was settled.
            */}
            {settlementState === 'nothing_billed' ? (
              <View style={[styles.stateChip, styles.stateChipNothingBilled]}>
                <Text style={[styles.stateChipText, styles.stateChipTextNothingBilled]}>
                  {'Nothing to pay · rounds were cancelled'}
                </Text>
              </View>
            ) : null}
            {settlementState === 'partially_paid' ? (
              <View style={[styles.stateChip, styles.stateChipPartial]}>
                <Text style={[styles.stateChipText, styles.stateChipTextPartial]}>
                  {'Part paid · balance still owed'}
                </Text>
              </View>
            ) : null}
            {settlementState === 'fully_paid' ? (
              <View style={[styles.stateChip, styles.stateChipPaid]}>
                <Text style={[styles.stateChipText, styles.stateChipTextPaid]}>
                  {'Paid in full · table still open'}
                </Text>
              </View>
            ) : null}
            {settlementState === 'closed' ? (
              <View style={[styles.stateChip, styles.stateChipClosed]}>
                <Text style={[styles.stateChipText, styles.stateChipTextClosed]}>
                  {'Paid in full · table closed'}
                </Text>
              </View>
            ) : null}
            {settlementState === 'unknown' ? (
              <View style={[styles.stateChip, styles.stateChipUnknown]}>
                <Text style={[styles.stateChipText, styles.stateChipTextUnknown]}>
                  {'Payment status unavailable · do not assume the bill is settled'}
                </Text>
              </View>
            ) : null}

            {/* The server's unpaid_total, never a client-side sum. Absent stays absent. */}
            {owed != null && settleOffered ? (
              <Text style={styles.owedAmount}>{formatMoney(owed)}</Text>
            ) : null}
          </View>

          {hasLines && summary ? (
            <View style={styles.summaryRow}>
              <View style={styles.summaryCell}>
                <Text style={styles.summaryValue}>{summary.outstanding}</Text>
                <Text style={styles.summaryLabel}>
                  {Copy.TABLE_OUTSTANDING_LABEL}
                </Text>
              </View>
              <View style={styles.summaryCell}>
                <Text style={styles.summaryValue}>{summary.ready}</Text>
                <Text style={styles.summaryLabel}>{Copy.TABLE_READY_LABEL}</Text>
              </View>
              <View style={styles.summaryCell}>
                <Text style={styles.summaryValue}>{items}</Text>
                {/* summary.total_lines counts FULFILMENT LINES, not items — a both-routed item is
                    one line. Showing the summed quantities avoids presenting one as the other. */}
                <Text style={styles.summaryLabel}>items</Text>
              </View>
            </View>
          ) : null}


          {/**
            * COOKED PROGRESS — a count, under the existing summary rather than inside it.
            *
            * Not a fourth summary cell: outstanding / ready / items are single numbers, and
            * "2 of 5" is a ratio that would read as a number in that row. It sits below, one line
            * per station that actually owes work, so a food-only tab shows no bar line at all
            * rather than "Bar 0 of 0".
            *
            * Absent on an older server, which renders nothing — the pre-change screen.
            */}
          {hasLines && (cooked.kitchen || cooked.bar) ? (
            <View style={styles.cookedProgressRow}>
              {cooked.kitchen ? (
                <Text style={styles.cookedProgressText}>
                  {Copy.TABLE_COOKED_PROGRESS_KITCHEN.replace(
                    '{cooked}',
                    String(cooked.kitchen.cooked),
                  ).replace('{total}', String(cooked.kitchen.total))}
                </Text>
              ) : null}
              {cooked.bar ? (
                <Text style={styles.cookedProgressText}>
                  {Copy.TABLE_COOKED_PROGRESS_BAR.replace(
                    '{cooked}',
                    String(cooked.bar.cooked),
                  ).replace('{total}', String(cooked.bar.total))}
                </Text>
              ) : null}
            </View>
          ) : null}
          {/* has_lines: false — a QR or pre-migration tab. The bill is right; readiness is simply
              not tracked for it, and the screen says exactly that rather than inventing a badge. */}
          {payload && !hasLines ? (
            <View style={styles.noticePanel}>
              <MaterialCommunityIcons
                name="information-outline"
                size={20}
                color={Colors.textSecondary}
              />
              <Text style={styles.noticeText}>
                {Copy.TABLE_NO_LINE_TRACKING}
              </Text>
            </View>
          ) : null}

          {hasLines
            ? payload!.orders.map(order => (
                <View key={order.order_id} style={styles.orderBlock}>
                  <View style={styles.orderHeader}>
                    <Text style={styles.orderHeading}>
                      {Copy.TABLE_ORDER_HEADING.replace(
                        '{number}',
                        String(order.order_number),
                      )}
                    </Text>
                    {/* The SERVER's elapsed seconds, never a device-clock subtraction. */}
                    {formatAge(order.seconds_since_placed) ? (
                      <Text style={styles.orderAge}>
                        {formatAge(order.seconds_since_placed)}
                      </Text>
                    ) : null}
                  </View>
                  {order.order_instructions ? (
                    <Text style={styles.orderInstructions}>
                      {order.order_instructions}
                    </Text>
                  ) : null}
                  {order.lines.map(line => (
                    <LineRow key={line.id} line={line} onEdit={setEditingLine} />
                  ))}
                </View>
              ))
            : null}

          {payload && hasLines && payload.orders.length === 0 ? (
            <Text style={styles.emptyText}>{Copy.TABLE_EMPTY_NO_ORDERS}</Text>
          ) : null}
        </ScrollView>
      )}

      <View
        style={[styles.bottomBar, {paddingBottom: insets.bottom + Spacing.sm}]}>
        <View style={styles.bottomActions}>
          {/*
            SETTLE, alongside Add Round rather than instead of it. Both remain available on a
            partially paid tab: the party can still order, and they can still pay for what is
            left, in either order and as many times as it takes.

            Disabled — not hidden — when there is nothing to settle or the state is unknown, so
            the control does not appear and vanish between refreshes.
          */}
          <Pressable
            style={[
              styles.settleButton,
              !settleOffered && styles.settleButtonDisabled,
            ]}
            disabled={!settleOffered}
            accessibilityState={{disabled: !settleOffered}}
            onPress={handleSettle}>
            <MaterialCommunityIcons
              name="cash-multiple"
              size={22}
              color={settleOffered ? Colors.white : Colors.textMuted}
            />
            <Text
              style={[
                styles.settleButtonText,
                !settleOffered && styles.settleButtonTextDisabled,
              ]}>
              {'Take payment'}
            </Text>
          </Pressable>

          <Pressable style={styles.addRoundButton} onPress={handleAddRound}>
            <MaterialCommunityIcons name="plus" size={24} color={Colors.white} />
            <Text style={styles.addRoundText}>
              {Copy.TABLE_ADD_ROUND_BUTTON}
            </Text>
          </Pressable>

          {/*
            SPLIT BILL — beside Add Round, not beside Take payment.

            Splitting is an ASSIGNMENT step that happens before money moves, and putting it next to
            Take payment would read as a second way to settle the whole table. It is only offered
            when the tab has lines: a QR or pre-migration tab has a bill but no fulfilment lines to
            assign, and the server would have nothing to allocate.
          */}
          {hasLines ? (
            <Pressable
              testID="table-split-bill"
              style={styles.addRoundButton}
              onPress={() =>
                navigation.navigate('ServiceSplitAssign', {
                  tabId,
                  tableNumber,
                })
              }>
              <MaterialCommunityIcons
                name="account-multiple-outline"
                size={24}
                color={Colors.white}
              />
              <Text style={styles.addRoundText}>{Copy.SPLIT_ENTRY_BUTTON}</Text>
            </Pressable>
          ) : null}
        </View>

        {/*
          CLOSE TABLE, BELOW the Take payment / Add Round row rather than beside it.

          Settling does not end a session — only this does — and the two must not read as a pair
          of equivalent buttons: one takes money and leaves the table live, the other ends the
          session and cannot be undone from the floor. Keeping it on its own row is what stops a
          waiter reaching for it while aiming at Take payment.

          The whole control, including all twelve refusals, lives in components/CloseTableAction,
          so this screen gains one element and no policy. Nothing here closes anything on its own:
          the component acts only on a press.
        */}
        <View style={styles.closeTableSlot}>
          <CloseTableAction
            tableId={tableId}
            tabId={tabId}
            unsentRoundLineCount={
              sessionTable && sessionTable.tabId === tabId
                ? sessionLines.length
                : 0
            }
            onClosed={() => navigation.goBack()}
          />
        </View>
      </View>

      {/*
        AMEND. Mounted at the screen root rather than inside the line list so the sheet survives
        the list re-rendering under it — a refresh mid-edit must not close the sheet the waiter is
        typing into.

        `onAmended` refetches rather than patching state locally: the amendment created a NEW
        ORDER on this tab, and the only honest way to show that is to re-read the tab. Editing the
        local copy would leave the bill and the line list disagreeing about what was ordered.
      */}
      <AmendLineSheet
        tabId={tabId}
        line={editingLine}
        onClose={() => setEditingLine(null)}
        onAmended={() => {
          setEditingLine(null);
          void load();
        }}
      />
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
  titleBlock: {flex: 1, alignItems: 'center'},
  screenTitle: {...Typography.subheading, color: Colors.textPrimary},
  screenSubtitle: {...Typography.tiny, color: Colors.textSecondary},
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  content: {padding: Spacing.md, paddingBottom: Spacing.xl},
  errorPanel: {
    backgroundColor: Colors.redLight,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  errorText: {...Typography.small, color: Colors.red},
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.background,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  retryButtonText: {color: Colors.textPrimary, fontSize: 16, fontWeight: '600'},
  billPanel: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  billLabel: {...Typography.small, color: Colors.textSecondary},
  billAmount: {fontSize: 26, fontWeight: '800', color: Colors.textPrimary},
  summaryRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  summaryCell: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  summaryValue: {fontSize: 22, fontWeight: '800', color: Colors.textPrimary},
  summaryLabel: {...Typography.tiny, color: Colors.textSecondary, marginTop: 2},
  noticePanel: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    marginTop: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noticeText: {flex: 1, ...Typography.small, color: Colors.textSecondary},
  noticeBanner: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'center',
    backgroundColor: Colors.blueLight,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    minHeight: 56,
  },
  noticeBannerText: {flex: 1, ...Typography.small, color: Colors.blue},
  orderBlock: {marginTop: Spacing.lg},
  orderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  orderHeading: {
    ...Typography.small,
    fontWeight: '800',
    color: Colors.textSecondary,
    letterSpacing: 0.4,
  },
  orderAge: {...Typography.tiny, color: Colors.textMuted},
  orderInstructions: {
    ...Typography.small,
    color: Colors.textSecondary,
    fontStyle: 'italic',
    marginBottom: Spacing.xs,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    minHeight: 64,
  },
  cookedProgressRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  /** Secondary by design: progress informs the decision to walk over, it never triggers it. */
  cookedProgressText: {...Typography.small, color: Colors.textSecondary},
  lineRowVoided: {opacity: 0.55},
  lineQty: {
    ...Typography.body,
    fontWeight: '800',
    color: Colors.textPrimary,
    minWidth: 32,
  },
  lineMain: {flex: 1},
  lineName: {...Typography.body, color: Colors.textPrimary},
  lineNameVoided: {textDecorationLine: 'line-through'},
  lineNote: {...Typography.small, color: Colors.textSecondary, marginTop: 2},
  unroutedRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
    alignItems: 'flex-start',
    marginTop: Spacing.xs,
  },
  unroutedText: {flex: 1, ...Typography.tiny, color: Colors.red},
  lineChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: 8,
  },
  lineChipReady: {backgroundColor: Colors.greenLight},
  /**
   * Collected: the Ready chip with the fill removed and an outline left behind. It must not read
   * as a THIRD status colour — it is the same status, already dealt with — so it borrows the ready
   * palette at low emphasis rather than introducing a colour of its own.
   */
  /**
   * A partial chip carries three words instead of one. It keeps the amber "still being made"
   * palette — nothing about it is done — and is allowed to shrink rather than push the dish name
   * off the row, which on a P5 held one-handed is the text that matters most.
   */
  lineChipPartial: {flexShrink: 1},
  lineChipCollected: {
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  lineChipTextCollected: {color: Colors.textMuted},
  lineChipWaiting: {backgroundColor: Colors.amberLight},
  lineChipVoided: {backgroundColor: Colors.surface},
  lineChipText: {fontSize: 11, fontWeight: '800', letterSpacing: 0.3},
  lineChipTextReady: {color: Colors.green},
  lineChipTextWaiting: {color: Colors.amber},
  lineChipTextVoided: {color: Colors.textMuted},
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.xl,
  },
  bottomBar: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  addRoundButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    minHeight: 60,
  },
  addRoundText: {color: Colors.white, fontSize: 18, fontWeight: '700'},
  bottomActions: {flexDirection: 'row', gap: Spacing.sm},
  settleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    backgroundColor: Colors.green,
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: Spacing.sm,
    minHeight: 60,
  },
  settleButtonDisabled: {backgroundColor: Colors.surface},
  settleButtonText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  settleButtonTextDisabled: {color: Colors.textMuted},
  paymentStateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  stateChip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: 8,
    flexShrink: 1,
  },
  stateChipUnpaid: {backgroundColor: Colors.amberLight},
  stateChipPartial: {backgroundColor: Colors.blueLight},
  stateChipPaid: {backgroundColor: Colors.greenLight},
  stateChipClosed: {backgroundColor: Colors.surface},
  stateChipUnknown: {backgroundColor: Colors.redLight},
  // Red, like 'unknown': both are states where acting on the obvious reading loses money.
  stateChipNothingBilled: {backgroundColor: Colors.redLight},
  stateChipText: {fontSize: 11, fontWeight: '800', letterSpacing: 0.3},
  stateChipTextUnpaid: {color: Colors.amber},
  stateChipTextPartial: {color: Colors.blue},
  stateChipTextPaid: {color: Colors.green},
  stateChipTextClosed: {color: Colors.textMuted},
  stateChipTextUnknown: {color: Colors.red},
  stateChipTextNothingBilled: {color: Colors.red},
  owedAmount: {fontSize: 16, fontWeight: '800', color: Colors.textPrimary},
  closeTableSlot: {marginTop: Spacing.sm},
});
