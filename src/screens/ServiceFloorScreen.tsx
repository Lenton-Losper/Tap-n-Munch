import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/serviceCopy';
import {
  ApiRequestError,
  FloorTable,
  getFloorTables,
  getTabLines,
} from '../lib/api';
import {formatSecondsOpen} from '../lib/serviceRound';
import {
  deriveTableBadge,
  mergeTableBadges,
  TableBadge,
  TableFlag,
} from '../lib/tabLines';
import {getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';
import {MainStackParamList} from '../navigation/AppNavigator';

type NavProp = NativeStackNavigationProp<MainStackParamList>;

const REFRESH_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * How many tab-line requests may be in flight at once while the grid decorates itself.
 *
 * The flags cost one request PER OPEN TABLE — there is no bulk endpoint — so a busy Riviera night
 * is a dozen or more calls per refresh on a P5 over venue wifi. Four at a time keeps the grid
 * responsive without queueing the whole floor behind one slow response, and the fetch is
 * best-effort throughout: rows render from the floor payload immediately and flags appear as they
 * land. A table whose lines cannot be fetched keeps the badge it last reported — see
 * mergeTableBadges.
 */
const FLAG_CONCURRENCY = 4;

/**
 * Badges are re-fetched no more often than this.
 *
 * NOW EQUAL TO THE GRID'S OWN POLL, so in practice every poll refreshes the badges. It was 30s,
 * which put up to 45 seconds between a kitchen bumping a dish and the waiter's grid saying so, and
 * 45 seconds under a heat lamp is most of the problem this badge exists to solve. Ruled explicitly:
 * N requests per 15s on this floor is not a load concern.
 *
 * It stays a separate named constant rather than collapsing into REFRESH_INTERVAL_MS because the
 * two throttle different things — one is a single grid request, the other is one request per open
 * table — and the day the floor gets big enough to care, this is the number to move, alone.
 */
const FLAG_MIN_INTERVAL_MS = REFRESH_INTERVAL_MS;

/** What a row renders before its tab has been read, or when it has no tab to read. */
const NO_BADGE: TableBadge = {flag: null, readyCount: 0};

function formatTotal(amount: number | null | undefined): string {
  const safe = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return `NAD ${safe.toFixed(2)}`;
}

function flagLabel(flag: TableFlag): string | null {
  switch (flag) {
    case 'ready':
      return Copy.FLAG_READY_LABEL;
    case 'waiting':
      return Copy.FLAG_WAITING_LABEL;
    case 'unrouted':
      return Copy.FLAG_UNROUTED_LABEL;
    default:
      return null;
  }
}

interface FloorRowProps {
  table: FloorTable;
  badge: TableBadge;
  /** Seconds elapsed on the DEVICE since the payload was fetched. A duration, never a clock. */
  elapsedSinceLoad: number;
  onPress: () => void;
}

function FloorRow({table, badge, elapsedSinceLoad, onPress}: FloorRowProps) {
  const {flag, readyCount} = badge;
  // `state` — never `table_status`. The two disagree in production in both directions (#216, and
  // the abandoned-tab reaper), and the brief returns table_status for diagnosis only.
  const isOpen = table.state === 'open';
  const secondsOpen =
    table.seconds_open != null ? table.seconds_open + elapsedSinceLoad : null;
  const label = flagLabel(flag);
  const age = formatSecondsOpen(secondsOpen);

  return (
    <Pressable
      style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}>
      <View
        style={[
          styles.numberBlock,
          isOpen ? styles.numberBlockOpen : styles.numberBlockFree,
        ]}>
        <Text
          style={[
            styles.tableNumber,
            isOpen ? styles.tableNumberOpen : styles.tableNumberFree,
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit>
          {table.table_number}
        </Text>
      </View>

      <View style={styles.rowMain}>
        <View style={styles.rowTopLine}>
          <Text
            style={[
              styles.stateText,
              isOpen ? styles.stateTextOpen : styles.stateTextFree,
            ]}>
            {isOpen ? Copy.FLOOR_STATE_OPEN : Copy.FLOOR_STATE_FREE}
          </Text>
          {table.table_name ? (
            <Text style={styles.tableName} numberOfLines={1}>
              {table.table_name}
            </Text>
          ) : null}
        </View>

        {isOpen ? (
          <>
            {/* A null owner on an open table is legitimate — a QR-opened tab, or an assignment
                that failed while the tab succeeded. Show it as open with no name; never block. */}
            <Text style={styles.metaText} numberOfLines={1}>
              {table.owner?.name ?? Copy.FLOOR_OWNER_UNASSIGNED}
              {age ? ` · ${age}` : ''}
            </Text>
            <Text style={styles.tabTotal}>{formatTotal(table.tab?.total)}</Text>
          </>
        ) : (
          <Text style={styles.freeHint}>{Copy.FLOOR_FREE_HINT}</Text>
        )}
      </View>

      {/* THE COUNT IS A NUMERAL IN ITS OWN ELEMENT, NOT A COMPOSED SENTENCE. Nothing here invents
          staff-facing wording: the label is the existing FLAG_READY_LABEL and the number is a
          number, so there is no new string for anyone to sign off. Rendered only above zero — see
          TableBadge.readyCount on why "READY 0" is reachable and must never appear. */}
      {label ? (
        <View
          style={[
            styles.flagChip,
            flag === 'ready' && styles.flagChipReady,
            flag === 'waiting' && styles.flagChipWaiting,
            flag === 'unrouted' && styles.flagChipUnrouted,
          ]}>
          <Text style={styles.flagChipText} numberOfLines={1}>
            {label}
          </Text>
          {flag === 'ready' && readyCount > 0 ? (
            <View style={styles.flagCount}>
              <Text style={styles.flagCountText}>{readyCount}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <MaterialCommunityIcons
        name="chevron-right"
        size={26}
        color={Colors.textMuted}
      />
    </Pressable>
  );
}

export default function ServiceFloorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavProp>();
  const {endSession} = useServiceSession();

  const [tables, setTables] = useState<FloorTable[]>([]);
  const [badges, setBadges] = useState<Record<string, TableBadge>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Non-null only for the unrecoverable 403 case. Everything else is a soft banner. */
  const [hardError, setHardError] = useState<string | null>(null);
  const [softError, setSoftError] = useState<string | null>(null);
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  const [elapsedSinceLoad, setElapsedSinceLoad] = useState(0);

  const backoffRef = useRef(REFRESH_INTERVAL_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);
  const flagsFetchedAtRef = useRef(0);

  /**
   * Decorate the grid with the derived badges.
   *
   * BEST-EFFORT AND NON-BLOCKING BY DESIGN. It never sets an error and never gates the rows on its
   * own completion — the floor is usable the instant the tables land, and badges appear as they
   * arrive. A banner per failed tab would cover the floor in warnings every time one read failed.
   *
   * FAILURE IS NO LONGER ERASURE. The result is MERGED over what is already on screen rather than
   * replacing it, so a table whose read failed keeps the badge it last reported instead of blinking
   * out until the next pass. Eviction is driven by the eligible set — the tables THIS floor payload
   * says are open with a tab — so a settled or freed table loses its badge on the next successful
   * grid poll regardless of what its own endpoint is doing. See mergeTableBadges for why the two
   * bounds together mean stale badges cannot accumulate.
   */
  const loadBadges = useCallback(async (current: FloorTable[]) => {
    const now = Date.now();
    if (now - flagsFetchedAtRef.current < FLAG_MIN_INTERVAL_MS) {
      return;
    }
    flagsFetchedAtRef.current = now;

    const targets = current.filter(t => t.state === 'open' && t.tab?.id);
    const eligibleIds = targets.map(t => t.id);

    if (targets.length === 0) {
      // Not a failure — the floor genuinely has no open tab to decorate. An empty eligible set
      // clears everything, which is the same eviction rule as every other pass.
      setBadges({});
      return;
    }

    const token = await getTerminalToken();
    if (!token) {
      // We found nothing out. Leave every badge exactly as it is rather than blanking the floor
      // on a storage read that will almost certainly succeed next time.
      return;
    }

    const fetched: Record<string, TableBadge> = {};
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= targets.length || !focusedRef.current) {
          return;
        }
        const table = targets[index];
        const tabId = table.tab?.id;
        if (!tabId) {
          continue;
        }
        try {
          const payload = await getTabLines(tabId, token);
          fetched[table.id] = deriveTableBadge(payload);
        } catch {
          // Silent, and deliberately leaves no key in `fetched`. An absent key is what tells the
          // merge "we did not find out" — as opposed to a present badge whose flag is null, which
          // is the real answer "read it fine, nothing to flag".
        }
      }
    };

    await Promise.all(
      Array.from({length: Math.min(FLAG_CONCURRENCY, targets.length)}, () =>
        worker(),
      ),
    );

    if (focusedRef.current) {
      setBadges(previous => mergeTableBadges(previous, fetched, eligibleIds));
    }
  }, []);

  const load = useCallback(
    async (mode: 'initial' | 'pull' | 'poll') => {
      if (mode === 'pull') {
        setRefreshing(true);
      } else if (mode === 'initial') {
        setLoading(true);
      }

      try {
        const token = await getTerminalToken();
        if (!token) {
          throw new Error(
            'Terminal session not found. Re-activate this terminal.',
          );
        }
        const payload = await getFloorTables(token);
        const sorted = [...payload.tables].sort(
          (a, b) => a.table_number - b.table_number,
        );
        setTables(sorted);
        setLoadedAtMs(Date.now());
        setElapsedSinceLoad(0);
        setHardError(null);
        setSoftError(null);
        backoffRef.current = REFRESH_INTERVAL_MS;

        if (mode === 'pull') {
          // An explicit pull is a request for fresh everything, flags included.
          flagsFetchedAtRef.current = 0;
        }
        loadBadges(sorted);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 403) {
          // Not recoverable on the device: the terminal token itself lacks orders:read.
          setHardError(
            `${err.message}. This terminal is not permitted to read tables — a manager must fix its role in the dashboard.`,
          );
        } else {
          // Keep showing the last good grid and retry with backoff.
          setSoftError(Copy.FLOOR_OFFLINE_BANNER);
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [loadBadges],
  );

  // Poll on a timer while focused. Rescheduled from the tail of each attempt rather than on a
  // fixed interval, so a slow response cannot stack requests on top of each other.
  const scheduleNext = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(async () => {
      if (!focusedRef.current) {
        return;
      }
      await load('poll');
      if (focusedRef.current) {
        scheduleNext();
      }
    }, backoffRef.current);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      // ARRIVING AT THE FLOOR BY ANY ROUTE DROPS THE HELD WAITER — after a Send, after backing out
      // of a half-built round, after merely looking at a table. Terminals are shared and pass from
      // hand to hand mid-service; the next attributable act must cost a PIN again. The round just
      // sent is unaffected, because attribution is read server-side from the tab.
      endSession();
      load('initial').then(() => scheduleNext());
      return () => {
        focusedRef.current = false;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }, [endSession, load, scheduleNext]),
  );

  // Ticks the "time open" counters between refreshes. Measures a DURATION from a locally-recorded
  // instant, which is safe; it never rebuilds the figure from `opened_at` and the device clock,
  // which is not — a terminal off a shelf has no trustworthy wall clock.
  useEffect(() => {
    if (loadedAtMs == null) {
      return;
    }
    const id = setInterval(() => {
      setElapsedSinceLoad(Math.floor((Date.now() - loadedAtMs) / 1000));
    }, 30_000);
    return () => clearInterval(id);
  }, [loadedAtMs]);

  const handlePress = useCallback(
    (table: FloorTable) => {
      if (table.state === 'open') {
        if (!table.tab?.id) {
          // Open with no tab id is a shape we cannot act on; a refresh is the honest answer.
          setSoftError(Copy.TABLE_LOAD_FAILED);
          load('pull');
          return;
        }
        // NO PIN TO LOOK AT A TABLE. Reading what a table has ordered is not an attributable act,
        // and a PIN prompt here would cost a waiter four digits to answer "is table 7's food up".
        // The PIN is spent on OPENING a tab, and the table view asks for one only when the waiter
        // chooses to add a round to a table this device did not open.
        navigation.navigate('ServiceTable', {
          tableId: table.id,
          tableNumber: table.table_number,
          tableName: table.table_name,
          tabId: table.tab.id,
          ownerName: table.owner?.name ?? null,
          ownerUserId: table.owner?.user_id ?? null,
        });
        return;
      }

      navigation.navigate('ServiceOpenTable', {
        tableId: table.id,
        tableNumber: table.table_number,
        tableName: table.table_name,
      });
    },
    [load, navigation],
  );

  if (hardError) {
    return (
      <View style={[styles.wrapper, {paddingTop: insets.top}]}>
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name="lock-alert-outline"
            size={44}
            color={Colors.red}
          />
          <Text style={styles.hardErrorText}>{hardError}</Text>
        </View>
      </View>
    );
  }

  const openCount = tables.filter(t => t.state === 'open').length;

  return (
    <View style={[styles.wrapper, {paddingTop: insets.top}]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{Copy.FLOOR_TITLE}</Text>
        <Text style={styles.headerSubtitle}>
          {Copy.FLOOR_SUBTITLE.replace('{open}', String(openCount)).replace(
            '{free}',
            String(tables.length - openCount),
          )}
        </Text>
      </View>

      {softError ? (
        <View style={styles.softBanner}>
          <MaterialCommunityIcons
            name="wifi-off"
            size={16}
            color={Colors.amber}
          />
          <Text style={styles.softBannerText} numberOfLines={2}>
            {softError}
          </Text>
        </View>
      ) : null}

      {loading && tables.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={tables}
          keyExtractor={item => item.id}
          contentContainerStyle={
            tables.length === 0 ? styles.emptyList : styles.list
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load('pull')}
              tintColor={Colors.primary}
            />
          }
          renderItem={({item}) => (
            <FloorRow
              table={item}
              badge={badges[item.id] ?? NO_BADGE}
              elapsedSinceLoad={elapsedSinceLoad}
              onPress={() => handlePress(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>{Copy.FLOOR_EMPTY}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: Colors.surface},
  header: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {...Typography.heading, color: Colors.textPrimary},
  headerSubtitle: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  softBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.amberLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  softBannerText: {flex: 1, ...Typography.tiny, color: Colors.amber},
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  list: {padding: Spacing.sm},
  emptyList: {flexGrow: 1},

  // ONE ROW PER TABLE, 84 tall, and the whole row is the target. The P5 is small and a waiter is
  // holding it one-handed while standing; a grid of cards puts two small targets side by side,
  // which is the opposite of what the brief asks for.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 84,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rowPressed: {opacity: 0.9, backgroundColor: Colors.surface},
  numberBlock: {
    width: 62,
    height: 62,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  numberBlockOpen: {backgroundColor: Colors.blue},
  numberBlockFree: {backgroundColor: Colors.surface},
  tableNumber: {fontSize: 26, fontWeight: '800'},
  tableNumberOpen: {color: Colors.white},
  tableNumberFree: {color: Colors.textSecondary},
  rowMain: {flex: 1, justifyContent: 'center'},
  rowTopLine: {flexDirection: 'row', alignItems: 'center', gap: Spacing.xs},
  stateText: {fontSize: 12, fontWeight: '800', letterSpacing: 0.6},
  stateTextOpen: {color: Colors.blue},
  stateTextFree: {color: Colors.textMuted},
  tableName: {flex: 1, ...Typography.tiny, color: Colors.textSecondary},
  metaText: {...Typography.small, color: Colors.textSecondary, marginTop: 2},
  tabTotal: {
    ...Typography.body,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginTop: 2,
  },
  freeHint: {...Typography.small, color: Colors.textMuted, marginTop: 2},
  flagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: 8,
    maxWidth: 116,
  },
  flagChipReady: {backgroundColor: Colors.green},
  flagChipWaiting: {backgroundColor: Colors.amber},
  flagChipUnrouted: {backgroundColor: Colors.red},
  flagChipText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  // A counter pill inside the chip, so the number reads as a quantity rather than as part of the
  // word. Sized to stay legible at arm's length on a P5 held one-handed.
  flagCount: {
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 10,
    backgroundColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flagCountText: {
    color: Colors.green,
    fontSize: 12,
    fontWeight: '800',
  },
  hardErrorText: {
    ...Typography.body,
    color: Colors.red,
    textAlign: 'center',
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
  },
});
