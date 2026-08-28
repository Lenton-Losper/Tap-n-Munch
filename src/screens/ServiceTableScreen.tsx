import React, {useCallback, useState} from 'react';
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
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/serviceCopy';
import {ApiRequestError, getTabLines} from '../lib/api';
import {
  formatAge,
  itemCount,
  TabLine,
  TabLinesPayload,
  tabRunningTotal,
} from '../lib/tabLines';
import {getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'ServiceTable'>;

function formatMoney(amount: number): string {
  return `NAD ${amount.toFixed(2)}`;
}

/**
 * One fulfilment line.
 *
 * The chip reads the SERVER's `is_ready`. It is not recomputed from kitchen_state/bar_state here —
 * those are shown as detail only. The station screens and this screen must agree about what
 * "ready" means, and they only do so if exactly one place decides it.
 */
function LineRow({line}: {line: TabLine}) {
  const chip = line.is_voided
    ? Copy.TABLE_LINE_VOIDED_CHIP
    : line.is_ready
    ? Copy.TABLE_LINE_READY_CHIP
    : Copy.TABLE_LINE_WAITING_CHIP;

  return (
    <View style={[styles.lineRow, line.is_voided && styles.lineRowVoided]}>
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
      <View
        style={[
          styles.lineChip,
          line.is_voided
            ? styles.lineChipVoided
            : line.is_ready
            ? styles.lineChipReady
            : styles.lineChipWaiting,
        ]}>
        <Text
          style={[
            styles.lineChipText,
            line.is_voided
              ? styles.lineChipTextVoided
              : line.is_ready
              ? styles.lineChipTextReady
              : styles.lineChipTextWaiting,
          ]}>
          {chip}
        </Text>
      </View>
    </View>
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
  const {table: sessionTable} = useServiceSession();

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    [tabId],
  );

  // Refetch on every focus, so returning from a round shows the lines it just created.
  useFocusEffect(
    useCallback(() => {
      load();
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
                    <LineRow key={line.id} line={line} />
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
        <Pressable style={styles.addRoundButton} onPress={handleAddRound}>
          <MaterialCommunityIcons name="plus" size={24} color={Colors.white} />
          <Text style={styles.addRoundText}>{Copy.TABLE_ADD_ROUND_BUTTON}</Text>
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
});
